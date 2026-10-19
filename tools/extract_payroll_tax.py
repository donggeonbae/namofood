"""Read the official NTS 2026-03-01 XLSX; emit one-person/no-child lookup facts.

Source: https://teht.hometax.go.kr/doc/sf/a/a/근로소득%20간이세액표_2026.03.01.xlsx
No workbook or project files are written. Usage: python tools/extract_payroll_tax.py FILE
"""
import json
import sys
import xml.etree.ElementTree as ET
import zipfile

with zipfile.ZipFile(sys.argv[1]) as workbook:
    ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    strings = ["".join(node.itertext()) for node in ET.fromstring(workbook.read("xl/sharedStrings.xml"))]
    sheet = ET.fromstring(workbook.read("xl/worksheets/sheet2.xml"))
    ranges = []
    exact = None
    for row in sheet.findall("s:sheetData/s:row", ns):
        cells = {}
        for cell in row:
            value = cell.find("s:v", ns)
            if value is not None:
                cells[cell.attrib["r"].rstrip("0123456789")] = strings[int(value.text)] if cell.attrib.get("t") == "s" else value.text
        if cells.get("A") == "10,000천원":
            exact = int(cells["C"])
        if not cells.get("A", "").isdigit() or not cells.get("B", "").isdigit():
            continue
        lower, upper = int(cells["A"]) * 1000, int(cells["B"]) * 1000
        tax = 0 if cells["C"] == "-" else int(cells["C"])
        assert lower < upper and tax >= 0
        ranges.append([lower, upper, tax])
    assert len(ranges) == 646 and ranges[0][0] == 770000 and ranges[-1][1] == 10000000
    assert all(a[1] == b[0] for a, b in zip(ranges, ranges[1:]))
    assert exact is not None
    points = [[0, 0]]
    for lower, upper, tax in ranges:
        if points[-1][1] != tax:
            points.append([lower, tax])
    points.append([10000000, exact])
    print(json.dumps({"ranges": len(ranges), "points": points, "examples": {str(gross): next((tax for low, high, tax in ranges if low <= gross < high), exact if gross == 10000000 else None) for gross in [1060000, 2000000, 2500000, 2800000, 3000000, 3500000, 5000000, 9980000, 10000000]}}, ensure_ascii=False))
