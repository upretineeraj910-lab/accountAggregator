import re
from typing import List, Dict, Any, Optional
from .models import Txn
from .common import words_to_lines, parse_date, parse_amount, clean_whitespace, Line, get_word_attr

ICICI_BLACKLIST_RE = re.compile(
    r"(?:www\.icici\.bank\.in|Never\s+share\s+your\s+OTP|Legends\s+for\s+transactions|Page\s+\d+\s+of\s+\d+|Transaction\s+Remarks|Withdrawal\s+Amount|Deposit\s+Amount|Balance\s*\(INR\))",
    re.IGNORECASE
)

CREDIT_KEYWORD_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:CR|SALARY|SAL|CREDIT|DEPOSIT|REFUND)(?![A-Za-z0-9])|INT[.\s]*PD",
    re.IGNORECASE
)

def parse_icici_words(words: List[Any]) -> List[Txn]:
    lines = words_to_lines(words)

    # 1. Determine column x-ranges from header words
    withdrawal_x_range: Optional[tuple] = None
    deposit_x_range: Optional[tuple] = None
    balance_x_range: Optional[tuple] = None

    for w in words[:300]:
        txt = str(get_word_attr(w, "text", "")).upper()
        x0 = float(get_word_attr(w, "x0", 0.0))
        x1 = float(get_word_attr(w, "x1", 0.0))
        if "WITHDRAWAL" in txt:
            withdrawal_x_range = (x0 - 25, x1 + 50)
        elif "DEPOSIT" in txt:
            deposit_x_range = (x0 - 25, x1 + 50)
        elif "BALANCE" in txt:
            balance_x_range = (x0 - 25, x1 + 50)

    # Default fallback boundaries if headers weren't found at exact coordinates
    # In standard ICICI statements (page width ~595):
    # Remarks ~ 100-340, Withdrawal ~ 340-420, Deposit ~ 420-500, Balance ~ 500-590
    if not withdrawal_x_range:
        withdrawal_x_range = (330.0, 420.0)
    if not deposit_x_range:
        deposit_x_range = (420.0, 505.0)
    if not balance_x_range:
        balance_x_range = (505.0, 600.0)

    raw_txns: List[Txn] = []
    current_tail: List[str] = []
    date_anchor: Optional[str] = None
    anchor_line: Optional[Line] = None

    def commit_row():
        nonlocal current_tail, date_anchor, anchor_line
        if date_anchor and anchor_line:
            # All lines belonging to this row
            all_lines = [anchor_line.text] + current_tail
            full_text = clean_whitespace(" ".join(all_lines))

            # Find all amounts across the anchor line
            anchor_words = sorted(anchor_line.words, key=lambda w: get_word_attr(w, "x0"))

            debit = 0.0
            credit = 0.0
            balance = 0.0

            found_amounts = []
            for w in anchor_words:
                w_txt = str(get_word_attr(w, "text", ""))
                amt = parse_amount(w_txt)
                if amt is not None:
                    found_amounts.append((amt, get_word_attr(w, "x0"), w_txt))

            # Direction from column x position
            for amt, x, txt_val in found_amounts:
                if balance_x_range[0] <= x:
                    balance = amt
                elif withdrawal_x_range[0] <= x < deposit_x_range[0]:
                    debit = abs(amt)
                elif deposit_x_range[0] <= x < balance_x_range[0]:
                    credit = abs(amt)

            # If direction couldn't be resolved by column positions
            if debit == 0.0 and credit == 0.0 and len(found_amounts) >= 2:
                amt = abs(found_amounts[-2][0])
                balance = found_amounts[-1][0]
                if CREDIT_KEYWORD_RE.search(full_text):
                    credit = amt
                else:
                    debit = amt

            # Clean narration: strip amounts, dates, and blacklist items
            narration_words = []
            for piece in full_text.split():
                if parse_date(piece) is not None:
                    continue
                if parse_amount(piece) is not None:
                    continue
                if ICICI_BLACKLIST_RE.search(piece):
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
        if ICICI_BLACKLIST_RE.search(t):
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
