import os
import io
import pytest
from unittest.mock import patch
from fastapi.testclient import TestClient

from core.models import Word, Txn
from core.detector import detect_bank
from core.holder import extract_holder, extract_holder_from_lines, clean_label_remnants
from core.chain import validate_and_order_chain, is_newest_first
from core.pnb import parse_pnb_words
from core.axis import parse_axis_words
from core.icici import parse_icici_words
from core.generic import parse_generic_words
from core import parse_words, PasswordRequiredException
from main import app

client = TestClient(app)

def make_word(text: str, x0: float, x1: float, top: float, bottom: float, page: int = 1) -> dict:
    return {
        "text": text,
        "x0": float(x0),
        "x1": float(x1),
        "top": float(top),
        "bottom": float(bottom),
        "page": page
    }

def words_from_line(line_text: str, top: float, start_x: float = 30.0, step_x: float = 40.0, page: int = 1):
    tokens = line_text.split()
    words = []
    x = start_x
    for tok in tokens:
        w_len = max(len(tok) * 6.0, 20.0)
        words.append(make_word(tok, x, x + w_len, top, top + 10.0, page=page))
        x += w_len + 5.0
    return words

# ==============================================================================
# 1. Profile Detection Tests
# ==============================================================================
def test_bank_detection():
    # PNB
    pnb_words = [
        make_word("PUNJAB", 10, 50, 10, 20),
        make_word("NATIONAL", 55, 90, 10, 20),
        make_word("BANK", 95, 120, 10, 20),
        make_word("Amount(INR)", 150, 200, 50, 60),
        make_word("Type", 210, 230, 50, 60),
        make_word("Remarks", 240, 280, 50, 60),
    ]
    assert detect_bank(pnb_words) == "pnb"

    # PNB ONE
    pnb_one_words = [
        make_word("Generated", 10, 50, 10, 20),
        make_word("through", 55, 90, 10, 20),
        make_word("PNB", 95, 120, 10, 20),
        make_word("ONE", 125, 150, 10, 20),
    ]
    assert detect_bank(pnb_one_words) == "pnb"

    # Axis
    axis_words = [
        make_word("Tran", 10, 30, 50, 60),
        make_word("Date", 35, 50, 50, 60),
        make_word("Particulars", 60, 120, 50, 60),
    ]
    assert detect_bank(axis_words) == "axis"

    # ICICI
    icici_words = [
        make_word("Transaction", 10, 60, 50, 60),
        make_word("Remarks", 65, 110, 50, 60),
        make_word("Withdrawal", 120, 170, 50, 60),
    ]
    assert detect_bank(icici_words) == "icici"

    # Generic
    generic_words = [
        make_word("Bank", 10, 40, 10, 20),
        make_word("Statement", 45, 90, 10, 20),
    ]
    assert detect_bank(generic_words) == "generic"

# ==============================================================================
# 2. Strict Holder & Header Profile Tests
# ==============================================================================
def test_holder_extraction_pnb_details_label_cleaning():
    lines = [
        "Customer Name: ABC DEF",
        "Branch Name: Details Name MATIA",
        "Account No: 12345678901234",
        "IFSC: PUNB0123456"
    ]
    holder = extract_holder_from_lines(lines)
    assert holder.name == "ABC DEF"
    assert holder.branch == "MATIA"  # "Details Name" stripped cleanly!
    assert holder.accountNo == "12345678901234"
    assert holder.ifsc == "PUNB0123456"

def test_holder_extraction_axis():
    lines = [
        "Statement of Axis Account No : 914010001234567",
        "Branch : ANDHERI WEST",
        "IFSC Code : UTIB0000123",
        "RAHUL SHARMA",
        "Joint Holder : NONE"
    ]
    holder = extract_holder_from_lines(lines)
    assert holder.name == "RAHUL SHARMA"
    assert holder.branch == "ANDHERI WEST"
    assert holder.accountNo == "914010001234567"
    assert holder.ifsc == "UTIB0000123"

def test_holder_extraction_icici():
    lines = [
        "ANITA VERMA Your Base Branch: BANDRA KURLA COMPLEX",
        "Account Number : 000401567890",
        "RTGS/NEFT IFSC : ICIC0000004"
    ]
    holder = extract_holder_from_lines(lines)
    assert holder.name == "ANITA VERMA"
    assert holder.branch == "BANDRA KURLA COMPLEX"
    assert holder.accountNo == "000401567890"
    assert holder.ifsc == "ICIC0000004"

# ==============================================================================
# 3. PNB ONE Profile Parser Tests (1-decimal, DR/CR, Multi-line Remarks)
# ==============================================================================
def test_pnb_parser_proximity_and_decimals():
    words = []
    # Header
    words.extend(words_from_line("Customer Name: ABC DEF", top=20))
    words.extend(words_from_line("Branch Name: MATIA", top=35))
    words.extend(words_from_line("Date Instrument ID Amount(INR) Type Balance Remarks", top=70))

    # Row 1: Fragment ABOVE anchor (top=92), Anchor (top=100), Fragment BELOW anchor (top=108)
    words.extend(words_from_line("UPI/DR/165240394537/Axis", top=92))
    words.extend(words_from_line("22/10/2026 700.0 DR 1654.93 Ban/UTIB/billpay.axb@upi/", top=100))
    words.extend(words_from_line("Payment for Electricity", top=108))

    # Row 2: Anchor with 1 decimal amount and CR (older than Row 1)
    words.extend(words_from_line("21/10/2026 1500.0 CR 2354.93 SALARY CREDIT PHARMANOVIA", top=140))

    # Blacklist lines near bottom (footer and bullet legend)
    words.extend(words_from_line("Generated through PNB ONE", top=200))
    words.extend(words_from_line("Date: 22/10/2026 17:47:62 Page 1", top=215))
    words.extend(words_from_line("● Abbreviations: DR Debit CR Credit", top=230))

    # Row 3 (oldest row near legend)
    words.extend(words_from_line("20/10/2026 50.0 DR 854.93 UPI/JAR", top=250))

    parsed = parse_words(words)
    assert parsed.profile == "pnb"
    assert len(parsed.txns) == 3

    # Check date ascending order after chain ordering
    assert parsed.txns[0].date == "2026-10-20"
    assert parsed.txns[1].date == "2026-10-21"
    assert parsed.txns[2].date == "2026-10-22"

    # Verify Row 22/10/2026 assembled fragments above and below in top-down order
    t22 = [t for t in parsed.txns if t.date == "2026-10-22"][0]
    assert t22.debit == 700.0
    assert t22.credit == 0.0
    assert t22.balance == 1654.93
    assert "UPI/DR/165240394537/Axis" in t22.narration
    assert "Ban/UTIB/billpay.axb@upi/" in t22.narration
    assert "Payment for Electricity" in t22.narration
    # Legend bullet and footer must NOT be in narration
    assert "Generated through PNB" not in t22.narration
    assert "Abbreviations" not in t22.narration

    # Verify Row 21/10/2026
    t21 = [t for t in parsed.txns if t.date == "2026-10-21"][0]
    assert t21.credit == 1500.0
    assert t21.debit == 0.0
    assert t21.balance == 2354.93

# ==============================================================================
# 4. Axis Bank Profile Tests (Narration First, Column Positions, Totals Blacklist)
# ==============================================================================
def test_axis_parser():
    words = []
    # Header words with specific x positions
    words.append(make_word("Tran", 30, 50, 50, 60))
    words.append(make_word("Date", 55, 75, 50, 60))
    words.append(make_word("Particulars", 90, 160, 50, 60))
    words.append(make_word("DR", 340, 360, 50, 60))
    words.append(make_word("CR", 420, 440, 50, 60))
    words.append(make_word("BAL", 500, 530, 50, 60))

    # Opening balance
    words.extend(words_from_line("OPENING BALANCE 10000.00", top=80))

    # Row 1: Narration precedes date row
    words.extend(words_from_line("NEFT CR-SALARY PHARMANOVIA", top=100))
    # Date row with Credit amount at x=425 and Balance at x=505
    words.append(make_word("25-09-2026", 30, 80, 115, 125))
    words.append(make_word("50000.00", 420, 460, 115, 125))
    words.append(make_word("60000.00", 500, 540, 115, 125))

    # Row 2: Narration precedes date row
    words.extend(words_from_line("UPI-SWIGGY FOOD ORDER", top=140))
    # Date row with Debit amount at x=345 and Balance at x=505
    words.append(make_word("26-09-2026", 30, 80, 155, 165))
    words.append(make_word("450.00", 340, 380, 155, 165))
    words.append(make_word("59550.00", 500, 540, 155, 165))

    # Stop / Blacklist section
    words.extend(words_from_line("TRANSACTION TOTAL 50000.00", top=200))
    words.extend(words_from_line("CLOSING BALANCE 59550.00", top=215))
    words.extend(words_from_line("Legends : DR - Debit", top=230))

    parsed = parse_words(words)
    assert parsed.profile == "axis"
    assert len(parsed.txns) == 2

    # Salary row
    assert parsed.txns[0].date == "2026-09-25"
    assert parsed.txns[0].credit == 50000.00
    assert parsed.txns[0].debit == 0.0
    assert parsed.txns[0].balance == 60000.00
    assert "SALARY" in parsed.txns[0].narration

    # Debit row
    assert parsed.txns[1].date == "2026-09-26"
    assert parsed.txns[1].debit == 450.00
    assert parsed.txns[1].credit == 0.0
    assert parsed.txns[1].balance == 59550.00

# ==============================================================================
# 5. ICICI Profile Tests (Withdrawal vs Deposit x-ranges, Negative Balance)
# ==============================================================================
def test_icici_parser():
    words = []
    # Header words defining column positions
    words.append(make_word("Transaction", 30, 80, 50, 60))
    words.append(make_word("Remarks", 85, 130, 50, 60))
    words.append(make_word("Withdrawal", 350, 400, 50, 60))
    words.append(make_word("Deposit", 440, 480, 50, 60))
    words.append(make_word("Balance", 520, 560, 50, 60))

    # Row 1: Overdraft / negative balance
    words.append(make_word("01/10/2026", 30, 80, 100, 110))
    words.append(make_word("ATM WITHDRAWAL CASH", 90, 200, 100, 110))
    words.append(make_word("1500.00", 360, 395, 100, 110))   # Withdrawal
    words.append(make_word("-500.00", 520, 555, 100, 110))   # Negative balance

    # Row 2: Deposit
    words.append(make_word("02/10/2026", 30, 80, 130, 140))
    words.append(make_word("NEFT INWARD SALARY", 90, 200, 130, 140))
    words.append(make_word("25000.00", 445, 485, 130, 140))  # Deposit
    words.append(make_word("24500.00", 520, 555, 130, 140))  # Balance

    # ICICI disclaimers
    words.extend(words_from_line("www.icici.bank.in Never share your OTP", top=200))
    words.extend(words_from_line("Legends for transactions", top=215))

    parsed = parse_words(words)
    assert parsed.profile == "icici"
    assert len(parsed.txns) == 2

    assert parsed.txns[0].debit == 1500.00
    assert parsed.txns[0].credit == 0.0
    assert parsed.txns[0].balance == -500.00

    assert parsed.txns[1].credit == 25000.00
    assert parsed.txns[1].debit == 0.0
    assert parsed.txns[1].balance == 24500.00

# ==============================================================================
# 6. Chain Validation & Reversal Tests
# ==============================================================================
def test_chain_validation_and_reversal():
    # Newest-first input
    raw_txns = [
        Txn(date="2026-10-03", narration="T3", debit=200.0, credit=0.0, balance=1800.0),
        Txn(date="2026-10-02", narration="T2", debit=0.0, credit=1000.0, balance=2000.0),
        Txn(date="2026-10-01", narration="T1", debit=0.0, credit=1000.0, balance=1000.0),
    ]

    ordered, quality = validate_and_order_chain(raw_txns)
    # Must be date ascending
    assert ordered[0].date == "2026-10-01"
    assert ordered[1].date == "2026-10-02"
    assert ordered[2].date == "2026-10-03"

    assert quality.ok is True
    assert quality.mismatches == 0
    assert quality.total == 2

def test_chain_mismatch_detection():
    # Broken balance chain
    raw_txns = [
        Txn(date="2026-10-01", narration="T1", debit=0.0, credit=1000.0, balance=1000.0),
        Txn(date="2026-10-02", narration="T2", debit=100.0, credit=0.0, balance=5000.0), # Broken: 1000 - 100 != 5000
    ]
    ordered, quality = validate_and_order_chain(raw_txns)
    assert quality.mismatches == 1
    assert quality.ok is False

# ==============================================================================
# 7. FastAPI Endpoint Tests
# ==============================================================================
def test_health_endpoint():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}

def test_api_key_auth():
    with patch.dict(os.environ, {"PARSER_KEY": "secret_123"}):
        # Missing key
        res = client.post("/parse", files={"file": ("stmt.pdf", b"%PDF-dummy", "application/pdf")})
        assert res.status_code == 401

        # Wrong key
        res = client.post(
            "/parse",
            files={"file": ("stmt.pdf", b"%PDF-dummy", "application/pdf")},
            headers={"X-API-Key": "wrong"}
        )
        assert res.status_code == 401

def test_non_pdf_rejected_415():
    res = client.post(
        "/parse",
        files={"file": ("stmt.txt", b"plain text data", "text/plain")}
    )
    assert res.status_code == 415

def test_file_too_large_413():
    # Payload over 10 MB
    large_bytes = b"0" * (10 * 1024 * 1024 + 10)
    res = client.post(
        "/parse",
        files={"file": ("stmt.pdf", large_bytes, "application/pdf")}
    )
    assert res.status_code == 413

def test_password_required_401():
    with patch("main.extract_words_from_pdf", side_effect=PasswordRequiredException("Locked")):
        res = client.post(
            "/parse",
            files={"file": ("stmt.pdf", b"%PDF-dummy", "application/pdf")}
        )
        assert res.status_code == 401
        data = res.json()
        assert data.get("needPassword") is True

def test_empty_transactions_422():
    with patch("main.extract_words_from_pdf", return_value=[]):
        res = client.post(
            "/parse",
            files={"file": ("stmt.pdf", b"%PDF-dummy", "application/pdf")}
        )
        assert res.status_code == 422

def test_generic_parser():
    words = []
    # Header defining generic columns
    words.append(make_word("Date", 30, 60, 50, 60))
    words.append(make_word("Description", 70, 150, 50, 60))
    words.append(make_word("Debit", 340, 380, 50, 60))
    words.append(make_word("Credit", 420, 460, 50, 60))
    words.append(make_word("Balance", 500, 540, 50, 60))

    # Row 1: Generic debit
    words.append(make_word("10/05/2026", 30, 70, 90, 100))
    words.append(make_word("Electricity Bill Payment", 80, 200, 90, 100))
    words.append(make_word("850.00", 340, 380, 90, 100))
    words.append(make_word("12500.00", 500, 540, 90, 100))

    # Row 2: Generic credit
    words.append(make_word("11/05/2026", 30, 70, 120, 130))
    words.append(make_word("Salary from XYZ Tech", 80, 200, 120, 130))
    words.append(make_word("45000.00", 420, 460, 120, 130))
    words.append(make_word("57500.00", 500, 540, 120, 130))

    parsed = parse_words(words)
    assert parsed.profile == "generic"
    assert len(parsed.txns) == 2
    assert parsed.txns[0].debit == 850.00
    assert parsed.txns[1].credit == 45000.00
    assert parsed.quality.ok is True

def test_parse_endpoint_full_flow():
    mock_words = [
        make_word("Customer", 30, 80, 20, 30),
        make_word("Name:", 85, 120, 20, 30),
        make_word("VIKRAM", 125, 160, 20, 30),
        make_word("SINGH", 165, 200, 20, 30),
        make_word("Amount(INR)", 100, 150, 50, 60),
        make_word("Type", 160, 180, 50, 60),
        make_word("Remarks", 190, 230, 50, 60),
        make_word("15/09/2026", 30, 80, 100, 110),
        make_word("1200.0", 90, 120, 100, 110),
        make_word("CR", 130, 150, 100, 110),
        make_word("5200.0", 160, 190, 100, 110),
        make_word("SALARY CREDIT", 200, 280, 100, 110),
    ]
    with patch("main.extract_words_from_pdf", return_value=mock_words):
        res = client.post(
            "/parse",
            files={"file": ("stmt.pdf", b"%PDF-1.4 test bytes", "application/pdf")}
        )
        assert res.status_code == 200
        data = res.json()
        assert data["profile"] == "pnb"
        assert len(data["txns"]) == 1
        assert data["txns"][0]["credit"] == 1200.0
        assert data["holder"]["name"] == "VIKRAM SINGH"
        assert data["quality"]["ok"] is True
