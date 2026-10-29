import re
from typing import List, Dict, Any, Optional
from .models import Txn
from .common import words_to_lines, parse_date, parse_amount, clean_whitespace, Line, get_word_attr

GENERIC_BLACKLIST_RE = re.compile(
    r"(?:Page\s+\d+\s+of\s+\d+|End\s+of\s+Statement|Statement\s+Period|Generated\s+on|Opening\s+Balance|Closing\s+Balance|Total\s+Withdrawal|Total\s+Deposit)",
    re.IGNORECASE
)

CREDIT_KEYWORD_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:CR|SALARY|SAL|CREDIT|DEPOSIT|REFUND)(?![A-Za-z0-9])|INT[.\s]*PD",
    re.IGNORECASE
)

def parse_generic_words(words: List[Any]) -> List[Txn]:
    lines = words_to_lines(words)

    # 1. Search for column headers
    debit_x_range: Optional[tuple] = None
    credit_x_range: Optional[tuple] = None
    balance_x_range: Optional[tuple] = None

    for w in words[:300]:
        txt = str(get_word_attr(w, "text", "")).upper()
        x0 = float(get_word_attr(w, "x0", 0.0))
        x1 = float(get_word_attr(w, "x1", 0.0))
        if any(h in txt for h in ("DR", "DEBIT", "WITHDRAWAL")):
            debit_x_range = (x0 - 20, x1 + 20)
        elif any(h in txt for h in ("CR", "CREDIT", "DEPOSIT")):
            credit_x_range = (x0 - 20, x1 + 20)
        elif any(h in txt for h in ("BAL", "BALANCE")):
            balance_x_range = (x0 - 20, x1 + 20)

    raw_txns: List[Txn] = []
    current_tail: List[str] = []
    date_anchor: Optional[str] = None
    anchor_line: Optional[Line] = None

    def commit_row():
        nonlocal current_tail, date_anchor, anchor_line
        if date_anchor and anchor_line:
            all_lines = [anchor_line.text] + current_tail
            full_text = clean_whitespace(" ".join(all_lines))

            # Find amounts
            anchor_words = sorted(anchor_line.words, key=lambda w: get_word_attr(w, "x0"))
            found_amounts = []
            for w in anchor_words:
                w_txt = str(get_word_attr(w, "text", ""))
                amt = parse_amount(w_txt)
                if amt is not None:
                    found_amounts.append((amt, get_word_attr(w, "x0"), w_txt))

            debit = 0.0
            credit = 0.0
            balance = 0.0

            if debit_x_range and credit_x_range and balance_x_range:
                for amt, x, txt_val in found_amounts:
                    if balance_x_range[0] <= x:
                        balance = amt
                    elif debit_x_range[0] <= x <= debit_x_range[1]:
                        debit = abs(amt)
                    elif credit_x_range[0] <= x <= credit_x_range[1]:
                        credit = abs(amt)

            if debit == 0.0 and credit == 0.0:
                if len(found_amounts) >= 2:
                    amt = abs(found_amounts[-2][0])
                    balance = found_amounts[-1][0]
                    if CREDIT_KEYWORD_RE.search(full_text) or found_amounts[-2][2].upper().endswith("CR"):
                        credit = amt
                    else:
                        debit = amt
                elif len(found_amounts) == 1:
                    balance = found_amounts[0][0]

            # Clean narration
            narration_words = []
            for piece in full_text.split():
                if parse_date(piece) is not None:
                    continue
                if parse_amount(piece) is not None:
                    continue
                if GENERIC_BLACKLIST_RE.search(piece):
                    continue
                narration_words.append(piece)
            clean_narration = clean_whitespace(" ".join(narration_words))

            raw_txns.append(
                Txn(
                    date=date_anchor,
                    narration=clean_narration,
                    debit=debit,
                    credit=credit,
                    balance=balance
                )
            )

        current_tail = []
        date_anchor = None
        anchor_line = None

    for line in lines:
        t = line.text
        if not t:
            continue
        if GENERIC_BLACKLIST_RE.search(t):
            continue

        first_token = t.split()[0]
        detected_date = parse_date(first_token)

        if detected_date:
            if date_anchor is not None:
                commit_row()
            date_anchor = detected_date
            anchor_line = line
        else:
            if date_anchor is not None:
                current_tail.append(t)

    commit_row()
    return raw_txns
