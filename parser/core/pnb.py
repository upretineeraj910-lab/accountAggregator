import re
from typing import List, Dict, Any, Optional
from .models import Txn
from .common import words_to_lines, parse_date, parse_amount, clean_whitespace, Line

PNB_ANCHOR_REGEX = re.compile(
    r"^(\d{2}/\d{2}/\d{4})\s+(\d[\d,]*\.\d{1,2})\s+(DR|CR)\s+(-?\d[\d,]*\.\d{1,2})\s*(.*)$",
    re.IGNORECASE
)

BLACKLIST_PATTERNS = [
    re.compile(r"^Date:\s*\d{2}/\d{2}/\d{4}", re.IGNORECASE),
    re.compile(r"Page\s+\d+", re.IGNORECASE),
    re.compile(r"Generated through PNB", re.IGNORECASE),
    re.compile(r"^[●•]"),
    re.compile(r"\bAbbreviations\b", re.IGNORECASE),
    re.compile(r"Amount\s*\(INR\)", re.IGNORECASE),
    re.compile(r"\bInstrument\s*ID\b", re.IGNORECASE),
    re.compile(r"\bType\b.*\bBalance\b.*\bRemarks\b", re.IGNORECASE),
]

MAX_DIST = 18.0

def is_pnb_blacklisted(text: str) -> bool:
    trimmed = text.strip()
    if not trimmed:
        return True
    for pat in BLACKLIST_PATTERNS:
        if pat.search(trimmed):
            return True
    return False

class PnbAnchor:
    def __init__(self, page: int, top: float, date_iso: str, amount: float, pnb_type: str, balance: float, inline_remarks: str):
        self.page = page
        self.top = top
        self.date_iso = date_iso
        self.amount = amount
        self.pnb_type = pnb_type.upper()
        self.balance = balance
        self.inline_remarks = inline_remarks
        self.fragments: List[Dict[str, Any]] = []

def parse_pnb_words(words: List[Any]) -> List[Txn]:
    lines = words_to_lines(words)

    anchors_by_page: Dict[int, List[PnbAnchor]] = {}
    all_anchors: List[PnbAnchor] = []
    fragments_by_page: Dict[int, List[Line]] = {}

    for line in lines:
        text = line.text
        if not text:
            continue

        match = PNB_ANCHOR_REGEX.match(text)
        if match:
            date_raw = match.group(1)
            date_iso = parse_date(date_raw) or date_raw
            amount = parse_amount(match.group(2)) or 0.0
            pnb_type = match.group(3).upper()
            balance = parse_amount(match.group(4)) or 0.0
            inline_remarks = match.group(5).strip()

            anchor = PnbAnchor(
                page=line.page,
                top=line.top,
                date_iso=date_iso,
                amount=amount,
                pnb_type=pnb_type,
                balance=balance,
                inline_remarks=inline_remarks
            )
            all_anchors.append(anchor)
            if line.page not in anchors_by_page:
                anchors_by_page[line.page] = []
            anchors_by_page[line.page].append(anchor)
        else:
            if not is_pnb_blacklisted(text):
                if line.page not in fragments_by_page:
                    fragments_by_page[line.page] = []
                fragments_by_page[line.page].append(line)

    # Proximity matching of fragments to anchors on the same page
    for page_num, page_fragments in fragments_by_page.items():
        page_anchors = anchors_by_page.get(page_num, [])
        if not page_anchors:
            continue

        for frag in page_fragments:
            nearest_anchor: Optional[PnbAnchor] = None
            min_dist = float("inf")

            for anchor in page_anchors:
                dist = abs(anchor.top - frag.top)
                if dist < min_dist:
                    min_dist = dist
                    nearest_anchor = anchor

            if nearest_anchor and min_dist <= MAX_DIST:
                nearest_anchor.fragments.append({"text": frag.text, "top": frag.top})

    # Assemble txns
    raw_txns: List[Txn] = []
    for anchor in all_anchors:
        pieces: List[Dict[str, Any]] = []
        if anchor.inline_remarks:
            pieces.append({"text": anchor.inline_remarks, "top": anchor.top})
        pieces.extend(anchor.fragments)

        # Sort pieces top ascending (physical top-to-bottom)
        pieces.sort(key=lambda p: p["top"])
        narration = clean_whitespace(" ".join(p["text"] for p in pieces))

        debit = anchor.amount if anchor.pnb_type == "DR" else 0.0
        credit = anchor.amount if anchor.pnb_type == "CR" else 0.0

        raw_txns.append(
            Txn(
                date=anchor.date_iso,
                narration=narration,
                debit=debit,
                credit=credit,
                balance=anchor.balance
            )
        )

    return raw_txns
