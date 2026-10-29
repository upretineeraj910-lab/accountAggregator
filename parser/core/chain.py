import re
from typing import List, Tuple
from .models import Txn, Quality

CREDIT_KW_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:CR|SALARY|SAL|CREDIT|DEPOSIT|REFUND)(?![A-Za-z0-9])|INT[.\s]*PD",
    re.IGNORECASE
)

def is_newest_first(txns: List[Txn]) -> bool:
    if len(txns) < 2:
        return False

    first_date = txns[0].date
    last_date = txns[-1].date
    if first_date > last_date:
        return True
    if first_date < last_date:
        return False

    # Dates are identical or mixed; check date order trends
    descending_count = 0
    ascending_count = 0
    for i in range(1, min(len(txns), 10)):
        if txns[i-1].date > txns[i].date:
            descending_count += 1
        elif txns[i-1].date < txns[i].date:
            ascending_count += 1

    return descending_count > ascending_count

def validate_and_order_chain(raw_txns: List[Txn]) -> Tuple[List[Txn], Quality]:
    """
    1. Reverses newest-first statements to chronological (date ascending).
    2. Resolves direction via balance difference if debit and credit were both 0.
    3. Validates balance chain equation: prev_balance + credit - debit == balance (tol 0.02).
    4. Calculates Quality metrics without modifying transaction amounts.
    """
    if not raw_txns:
        return [], Quality(ok=True, mismatches=0, total=0, firstRowUncertain=False)

    txns = list(raw_txns)
    if is_newest_first(txns):
        txns.reverse()

    first_row_uncertain = False

    # Check first row direction if both debit and credit are 0
    if len(txns) > 0 and txns[0].debit == 0.0 and txns[0].credit == 0.0:
        first_row_uncertain = True
        # If second row exists, we can deduce backwards or fallback to keyword
        if CREDIT_KW_RE.search(txns[0].narration):
            pass # remains 0 or handled by caller

    # Resolve direction for subsequent rows if both 0
    for i in range(1, len(txns)):
        curr = txns[i]
        prev = txns[i - 1]
        if curr.debit == 0.0 and curr.credit == 0.0:
            diff = round(curr.balance - prev.balance, 2)
            if diff > 0.01:
                curr.credit = diff
            elif diff < -0.01:
                curr.debit = abs(diff)

    # Balance chain validation
    total = max(0, len(txns) - 1)
    mismatches = 0

    for i in range(1, len(txns)):
        prev_bal = txns[i - 1].balance
        expected = round(prev_bal + txns[i].credit - txns[i].debit, 2)
        diff = abs(expected - txns[i].balance)
        if diff > 0.02:
            mismatches += 1

    ok = (mismatches / total <= 0.02) if total > 0 else True

    return txns, Quality(
        ok=ok,
        mismatches=mismatches,
        total=total,
        firstRowUncertain=first_row_uncertain
    )
