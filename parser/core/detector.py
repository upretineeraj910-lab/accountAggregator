from typing import List, Any
from .common import get_word_attr

def detect_bank(words: List[Any]) -> str:
    """
    Detect bank profile from header text tokens.
    Profiles: 'pnb', 'axis', 'icici', 'generic'.
    """
    if not words:
        return "generic"

    # Take first 400 words (usually page 1 header / table header)
    sample_text = " ".join(str(get_word_attr(w, "text", "")) for w in words[:400]).upper()

    # 1. PNB ONE detection
    if "PNB ONE" in sample_text or "PNBONE" in sample_text:
        return "pnb"
    if "AMOUNT(INR)" in sample_text and ("REMARKS" in sample_text or "TYPE" in sample_text):
        return "pnb"
    if "AMOUNT (INR)" in sample_text and ("REMARKS" in sample_text or "TYPE" in sample_text):
        return "pnb"

    # 2. Axis Bank detection
    if "TRAN DATE" in sample_text and "PARTICULARS" in sample_text:
        return "axis"

    # 3. ICICI Bank detection
    if "TRANSACTION REMARKS" in sample_text and ("WITHDRAWAL" in sample_text or "WITHDRAWAL AMOUNT" in sample_text):
        return "icici"

    return "generic"
