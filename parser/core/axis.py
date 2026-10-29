import re
from typing import List, Dict, Any, Optional
from .models import Txn
from .common import words_to_lines, parse_date, parse_amount, clean_whitespace, Line, get_word_attr

AXIS_STOP_RE = re.compile(
    r"^(?:TRANSACTION\s+TOTAL|CLOSING\s+BALANCE|\+{2,}\s*End\s+of\s+Statement|Legends\s*:)",
    re.IGNORECASE
)

AXIS_BLACKLIST_RE = re.compile(
    r"^(?:TRANSACTION\s+TOTAL|CLOSING\s+BALANCE|OPENING\s+BALANCE|Legends|Page\s+\d+\s+of\s+\d+|Tran\s+Date|Transaction\s+Date|Particulars)",
    re.IGNORECASE
)

CREDIT_KEYWORD_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:CR|SALARY|SAL|CREDIT|DEPOSIT|REFUND)(?![A-Za-z0-9])|INT[.\s]*PD",
    re.IGNORECASE
)

def parse_axis_words(words: List[Any]) -> List[Txn]:
    lines = words_to_lines(words)

    # 1. Detect column x-ranges from header words if present
    debit_x_range: Optional[tuple] = None
    credit_x_range: Optional[tuple] = None
    balance_x_range: Optional[tuple] = None

    for w in words[:200]:
        txt = str(get_word_attr(w, "text", "")).upper()
        x0 = float(get_word_attr(w, "x0", 0.0))
        x1 = float(get_word_attr(w, "x1", 0.0))
        if txt in ("DR", "DEBIT", "WITHDRAWAL"):
            debit_x_range = (x0 - 20, x1 + 20)
        elif txt in ("CR", "CREDIT", "DEPOSIT"):
            credit_x_range = (x0 - 20, x1 + 20)
        elif txt in ("BAL", "BALANCE"):
            balance_x_range = (x0 - 20, x1 + 20)

    # 2. Check if narrationFirst mode applies (narration lines before date row)
    narration_first = False
    found_opening = False
    for line in lines:
        t = line.text
        if re.search(r"^OPENING\s+BALANCE", t, re.IGNORECASE):
            found_opening = True
            continue
        if found_opening:
            if t and not AXIS_BLACKLIST_RE.search(t):
                if parse_date(t.split()[0]) is None:
                    narration_first = True
                break

    # 3. Group lines into row bands
    raw_txns: List[Txn] = []
    current_lead: List[str] = []
    current_tail: List[str] = []
    date_anchor: Optional[str] = None
    anchor_line: Optional[Line] = None

    def commit_row():
        nonlocal current_lead, current_tail, date_anchor, anchor_line
        if date_anchor and anchor_line:
            # Combine narration
            all_parts = []
            if narration_first:
                all_parts.extend(current_lead)
                # Words on anchor line that are narration (not date, not amounts)
                anchor_text = anchor_line.text
                all_parts.append(anchor_text)
                all_parts.extend(current_tail)
            else:
                all_parts.append(anchor_line.text)
                all_parts.extend(current_tail)

            # Clean narration text: strip dates, amount numbers, and blacklist words
            raw_narration = clean_whitespace(" ".join(all_parts))
            # Extract amounts from anchor line words
            anchor_words = sorted(anchor_line.words, key=lambda w: get_word_attr(w, "x0"))
            found_amounts = []
            for w in anchor_words:
                w_txt = str(get_word_attr(w, "text", ""))
                amt = parse_amount(w_txt)
                if amt is not None:
                    found_amounts.append((amt, get_word_attr(w, "x0"), w_txt))

            # Remove amounts and leading date from narration
            narration_words = []
            for piece in raw_narration.split():
                if parse_date(piece) is not None:
                    continue
                if parse_amount(piece) is not None:
                    continue
                if AXIS_BLACKLIST_RE.search(piece):
                    continue
                narration_words.append(piece)
            clean_narration = clean_whitespace(" ".join(narration_words))

            # Determine debit, credit, balance
            debit = 0.0
            credit = 0.0
            balance = 0.0

            if len(found_amounts) >= 2:
                # Typically [Txn Amount, Balance]
                txn_amt = abs(found_amounts[-2][0])
                balance = found_amounts[-1][0]
                txn_x = found_amounts[-2][1]

                # Check x column
                if debit_x_range and credit_x_range:
                    if debit_x_range[0] <= txn_x <= debit_x_range[1]:
                        debit = txn_amt
                    elif credit_x_range[0] <= txn_x <= credit_x_range[1]:
                        credit = txn_amt
                
                # If column range didn't decide, check keywords
                if debit == 0.0 and credit == 0.0:
                    if CREDIT_KEYWORD_RE.search(clean_narration) or found_amounts[-2][2].upper().endswith("CR"):
                        credit = txn_amt
                    else:
                        debit = txn_amt

            elif len(found_amounts) == 1:
                balance = found_amounts[0][0]

            raw_txns.append(
                Txn(
                    date=date_anchor,
                    narration=clean_narration,
                    debit=debit,
                    credit=credit,
                    balance=balance
                )
            )

        current_lead = []
        current_tail = []
        date_anchor = None
        anchor_line = None

    for line in lines:
        t = line.text
        if not t:
            continue
        if AXIS_STOP_RE.search(t):
            # Legend or footer line: drop without committing or ending future rows
            continue
        if AXIS_BLACKLIST_RE.search(t):
            continue

        # Check for date at start of line
        first_token = t.split()[0]
        detected_date = parse_date(first_token)

        if detected_date:
            if date_anchor is not None:
                commit_row()
            date_anchor = detected_date
            anchor_line = line
        else:
            if date_anchor is None:
                current_lead.append(t)
            else:
                current_tail.append(t)

    commit_row()
    return raw_txns
