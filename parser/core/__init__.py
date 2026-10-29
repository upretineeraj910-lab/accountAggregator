from typing import List, Any
from .models import Txn, Holder, Quality, ParseResponse
from .detector import detect_bank
from .holder import extract_holder
from .chain import validate_and_order_chain
from .extractor import extract_words_from_pdf, PasswordRequiredException
from .pnb import parse_pnb_words
from .axis import parse_axis_words
from .icici import parse_icici_words
from .generic import parse_generic_words

def parse_words(words: List[Any]) -> ParseResponse:
    profile = detect_bank(words)
    if profile == "pnb":
        raw_txns = parse_pnb_words(words)
    elif profile == "axis":
        raw_txns = parse_axis_words(words)
    elif profile == "icici":
        raw_txns = parse_icici_words(words)
    else:
        raw_txns = parse_generic_words(words)

    ordered_txns, quality = validate_and_order_chain(raw_txns)
    holder = extract_holder(words)

    return ParseResponse(
        profile=profile,
        txns=ordered_txns,
        holder=holder,
        quality=quality
    )
