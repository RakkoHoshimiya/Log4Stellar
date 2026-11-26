"""Read bounded text from OOXML without expanding documents onto disk."""
import io
import re
import resource
import sys
import xml.etree.ElementTree as ET
import zipfile

resource.setrlimit(resource.RLIMIT_AS, (192 * 1024**2, 192 * 1024**2))
READ_LIMIT = 24 * 1024**2
TOTAL_XML = 16 * 1024**2
OUTPUT_LIMIT = 48 * 1024
format_name = sys.argv[1]
patterns = {
    "docx": r"word/(document|footnotes|endnotes|header\d+|footer\d+)\.xml",
    "xlsx": r"xl/(sharedStrings|worksheets/sheet\d+)\.xml",
    "pptx": r"ppt/(slides/slide\d+|notesSlides/notesSlide\d+)\.xml",
}
source = sys.stdin.buffer.read(READ_LIMIT + 1)
if len(source) > READ_LIMIT:
    raise ValueError("file too large")
pieces = []
characters = 0
with zipfile.ZipFile(io.BytesIO(source)) as workbook:
    entries = [item for item in workbook.infolist() if re.fullmatch(patterns[format_name], item.filename)]
    if not entries or len(entries) > 300 or sum(item.file_size for item in entries) > TOTAL_XML:
        raise ValueError("invalid or oversized Office XML")
    for entry in entries:
        with workbook.open(entry) as item:
            xml = item.read(entry.file_size + 1).decode("utf-8-sig")
        if len(xml) > entry.file_size or re.search(r"<!\s*(DOCTYPE|ENTITY)", xml, re.I):
            raise ValueError("unsafe XML")
        for element in ET.fromstring(xml).iter():
            field = element.tag.rsplit("}", 1)[-1]
            if (field == "t" or (format_name == "xlsx" and field == "v")) and element.text:
                pieces.append(element.text[:OUTPUT_LIMIT - characters])
                characters += len(pieces[-1]) + 1
                if characters >= OUTPUT_LIMIT:
                    break
        if characters >= OUTPUT_LIMIT:
            break
sys.stdout.write(" ".join(pieces))
