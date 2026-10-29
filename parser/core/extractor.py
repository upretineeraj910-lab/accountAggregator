import io
from typing import List, Dict, Any, Optional
import pdfplumber
from pdfminer.pdfdocument import PDFPasswordIncorrect, PDFEncryptionError

class PasswordRequiredException(Exception):
    """Raised when PDF requires a password or the provided password is wrong."""
    pass

def extract_words_from_pdf(pdf_bytes: bytes, password: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Reads PDF strictly in-memory from bytes and extracts words with page and coordinate metadata.
    Zero disk writes.
    """
    stream = io.BytesIO(pdf_bytes)
    try:
        pdf_kwargs = {}
        if password:
            pdf_kwargs["password"] = password

        with pdfplumber.open(stream, **pdf_kwargs) as pdf:
            all_words: List[Dict[str, Any]] = []
            for page_idx, page in enumerate(pdf.pages, start=1):
                page_words = page.extract_words() or []
                for w in page_words:
                    w_copy = dict(w)
                    w_copy["page"] = page_idx
                    all_words.append(w_copy)
            return all_words
    except (PDFPasswordIncorrect, PDFEncryptionError) as e:
        raise PasswordRequiredException("PDF password required or incorrect.") from e
    except Exception as e:
        msg = str(e).lower()
        if "password" in msg or "encrypt" in msg:
            raise PasswordRequiredException("PDF password required or incorrect.") from e
        raise
