import re
from typing import List, Optional, Any
from .common import words_to_lines, clean_whitespace
from .models import Holder

EXCLUDE_WORDS_NAME_RE = re.compile(
    r"\b(?:BANK|BRANCH|STATEMENT|ACCOUNT|IFSC|ROAD|NAGAR|STREET|AVENUE|LANE|MARG|"
    r"COLONY|SECTOR|BLOCK|FLOOR|HOUSE|BUILDING|INDIA|LIMITED|LTD|PVT|DATE|PAGE|"
    r"TRANSACTION|PARTICULARS|BALANCE|CR|DR|INR|DETAILS|CUSTOMER|CITY|ADDRESS)\b",
    re.IGNORECASE
)

LABEL_STRIP_PREFIX_RE = re.compile(
    r"^(?:Details|Name|Branch|Customer|Address|City|Base|Your|Account|No|Number|Code)\b[:.\-]?\s*",
    re.IGNORECASE
)

def clean_label_remnants(s: str) -> str:
    if not s:
        return ""
    cur = re.sub(r"[:]+|\s*-\s*", " ", s)
    cur = clean_whitespace(cur)
    prev = ""
    while cur != prev:
        prev = cur
        cur = LABEL_STRIP_PREFIX_RE.sub("", cur).strip()
    return cur

def is_valid_name(val: Optional[str]) -> bool:
    if not val:
        return False
    trimmed = val.strip()
    if len(trimmed) < 3 or len(trimmed) > 40:
        return False
    if not re.match(r"^[A-Za-z\s.]+$", trimmed):
        return False
    if EXCLUDE_WORDS_NAME_RE.search(trimmed):
        return False

    without_title = re.sub(r"^(?:MR|MS|MRS|DR|SH|SMT)\b\.?\s*", "", trimmed, flags=re.IGNORECASE).strip()
    if len(without_title) < 2:
        return False

    return True

def clean_branch(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None

    # Cut off if adjacent headers exist on the same line
    cut = re.split(r"\b(?:IFSC|MICR|Date|Account|A\/c|Tel|Phone|Email|Pin|State|Customer)\b", raw, flags=re.IGNORECASE)[0]
    cleaned = clean_label_remnants(cut)
    cleaned = re.sub(r"[^A-Za-z\s.\-]", " ", cleaned)
    cleaned = clean_whitespace(cleaned)

    if len(cleaned) < 2 or len(cleaned) > 40:
        return None
    if re.match(r"^(?:Details|Name|Branch)\b", cleaned, flags=re.IGNORECASE):
        return None
    if re.match(r"^(?:BANK|BRANCH|DETAILS|NAME|ADDRESS|CITY|BASE)$", cleaned, flags=re.IGNORECASE):
        return None

    return cleaned

def extract_holder_from_lines(lines: List[str]) -> Holder:
    top_lines = lines[:45]

    name: Optional[str] = None
    branch: Optional[str] = None
    account_no: Optional[str] = None
    ifsc: Optional[str] = None

    # 1. Name Extraction
    for i, line in enumerate(top_lines):
        # PNB & Generic labelled: Customer Name:, Name:
        label_match = re.search(
            r"(?:Customer\s*(?:Details\s*)?Name|Account\s*Holder(?:\s*Name)?|Account\s*Name|"
            r"Primary\s*Account\s*Holder|Name\s*of\s*(?:the\s*)?Account\s*Holder)\s*[:.\-]?\s*(.+)",
            line,
            re.IGNORECASE
        )
        if label_match:
            cut = re.split(r"\s{2,}|\t|\b(?:Account\s*No|A\/c|Date|Branch|IFSC)\b", label_match.group(1), flags=re.IGNORECASE)[0]
            candidate = clean_label_remnants(cut)
            if is_valid_name(candidate):
                name = candidate
                break

        # Axis Bank anchor: line immediately preceding "Joint Holder"
        if re.search(r"Joint\s+Holder", line, re.IGNORECASE) and i > 0:
            prev_line = top_lines[i - 1].strip()
            candidate = clean_label_remnants(prev_line)
            if is_valid_name(candidate):
                name = candidate
                break

        # ICICI Bank anchor: inline "<Name> Your Base Branch"
        icici_inline = re.match(r"^([A-Za-z\s.]{3,40})\s+Your\s+Base\s+Branch", line, re.IGNORECASE)
        if icici_inline:
            candidate = clean_label_remnants(icici_inline.group(1))
            if is_valid_name(candidate):
                name = candidate
                break

        # ICICI Bank anchor: line above "Your Base Branch"
        if re.search(r"Your\s+Base\s+Branch", line, re.IGNORECASE) and i > 0:
            prev_line = top_lines[i - 1].strip()
            candidate = clean_label_remnants(prev_line)
            if is_valid_name(candidate):
                name = candidate
                break

    # Fallback name search if not found
    if not name:
        for line in top_lines[:25]:
            trimmed = line.strip()
            if re.match(r"^[A-Z][A-Za-z\s.]{3,35}$", trimmed):
                candidate = clean_label_remnants(trimmed)
                if is_valid_name(candidate):
                    name = candidate
                    break

    # 2. Branch Extraction
    for line in top_lines:
        branch_match = re.search(
            r"(?:Branch\s*(?:Details\s*)?Name|Base\s*Branch|Branch|Home\s*Branch)\s*[:.\-]?\s*(.+)",
            line,
            re.IGNORECASE
        )
        if branch_match:
            candidate = clean_branch(branch_match.group(1))
            if candidate:
                branch = candidate
                break

    # 3. Account Number Extraction
    for line in top_lines:
        acc_match = re.search(
            r"(?:Statement\s+of\s+Axis\s+Account\s+No|Account\s*(?:Number|No\.?)|A\/c\s*(?:Number|No\.?)|Account)\s*[:.\-]?\s*([A-Za-z0-9\-]+)",
            line,
            re.IGNORECASE
        )
        if acc_match:
            raw_acc = acc_match.group(1).replace("-", "").strip()
            if len(raw_acc) >= 6 and len(raw_acc) <= 25 and re.match(r"^\d+[A-Za-z0-9]*$", raw_acc):
                account_no = raw_acc
                break

    # 4. IFSC Extraction
    for line in top_lines:
        ifsc_match = re.search(r"\b([A-Z]{4}0[A-Z0-9]{6})\b", line)
        if ifsc_match:
            ifsc = ifsc_match.group(1).upper()
            break

    return Holder(
        name=name,
        branch=branch,
        accountNo=account_no,
        ifsc=ifsc
    )

def extract_holder(words: List[Any]) -> Holder:
    lines_objs = words_to_lines(words)
    lines_text = [l.text for l in lines_objs if l.text]
    return extract_holder_from_lines(lines_text)
