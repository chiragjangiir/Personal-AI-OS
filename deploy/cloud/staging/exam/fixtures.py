"""Generate isolated exam inputs with stdlib only; never manufacture audio evidence."""
from __future__ import annotations

import argparse
from datetime import date, timedelta
import json
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile


NS = "http://schemas.openxmlformats.org/"
REL = NS + "package/2006/relationships"
OFFICE_REL = NS + "officeDocument/2006/relationships/"


def _package(path: Path, parts: dict[str, str], overrides: dict[str, str], entry: str) -> None:
    types = ''.join(f'<Override PartName="/{name}" ContentType="{kind}"/>'
                    for name, kind in overrides.items())
    parts = {**parts, "[Content_Types].xml": (
        f'<Types xmlns="{NS}package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>' + types + '</Types>'),
        "_rels/.rels": _rels([("rId1", "officeDocument", entry)])}
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        for name, body in parts.items():
            archive.writestr(name, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + body)


def _rels(items: list[tuple[str, str, str]]) -> str:
    return f'<Relationships xmlns="{REL}">' + ''.join(
        f'<Relationship Id="{rid}" Type="{OFFICE_REL}{kind}" Target="{target}"/>'
        for rid, kind, target in items) + '</Relationships>'


def _docx(path: Path) -> None:
    paragraphs = ''.join(f'<w:p><w:r><w:t>{text}</w:t></w:r></w:p>' for text in
                         ("项目草案", "截止日：周三", "预算：3000元"))
    _package(path, {"word/document.xml":
        f'<w:document xmlns:w="{NS}wordprocessingml/2006/main"><w:body>{paragraphs}'
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>'},
        {"word/document.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"},
        "word/document.xml")


def _xlsx(path: Path) -> None:
    def cell(ref: str, value: str, formula: str | None = None) -> str:
        if formula is not None:
            return f'<c r="{ref}"><f>{formula}</f><v>{value}</v></c>'
        if value.isdigit():
            return f'<c r="{ref}"><v>{value}</v></c>'
        return f'<c r="{ref}" t="inlineStr"><is><t>{escape(value)}</t></is></c>'
    rows = [''.join(cell(f'{col}1', text) for col, text in zip("ABCD", ("项目", "数量", "单价", "总价"))),
            cell("A2", "资料") + cell("B2", "2") + cell("C2", "30") + cell("D2", "32", "B2+C2"),
            cell("A3", "用品") + cell("B3", "3") + cell("C3", "20") + cell("D3", "23", "B3+C3"),
            cell("A4", "合计") + cell("D4", "32", "SUM(D2:D2)")]
    parts = {"xl/workbook.xml": f'<workbook xmlns="{NS}spreadsheetml/2006/main" xmlns:r="{OFFICE_REL[:-1]}">'
             '<sheets><sheet name="预算" sheetId="1" r:id="rId1"/></sheets>'
             '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>',
             "xl/_rels/workbook.xml.rels": _rels([("rId1", "worksheet", "worksheets/sheet1.xml")]),
             "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{NS}spreadsheetml/2006/main">'
             '<dimension ref="A1:D4"/><sheetData>' + ''.join(
                 f'<row r="{i}">{body}</row>' for i, body in enumerate(rows, 1)) + '</sheetData></worksheet>'}
    _package(path, parts, {
        "xl/workbook.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        "xl/worksheets/sheet1.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"},
        "xl/workbook.xml")


def _pptx(path: Path) -> None:
    parts = {"ppt/presentation.xml": f'<p:presentation xmlns:p="{NS}presentationml/2006/main" '
             f'xmlns:r="{OFFICE_REL[:-1]}"><p:sldIdLst>' + ''.join(
                 f'<p:sldId id="{255+i}" r:id="rId{i}"/>' for i in range(1, 4)) +
             '</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
             "ppt/_rels/presentation.xml.rels": _rels([
                 (f"rId{i}", "slide", f"slides/slide{i}.xml") for i in range(1, 4)])}
    overrides = {"ppt/presentation.xml": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"}
    for i, (title, body) in enumerate((("结论", "本月实际120，目标150，仍需提升。"),
                                       ("数据", "实际：120；目标：150。"),
                                       ("下一步", "下月继续跟进差距，保留目标150。")), 1):
        texts = ("数据月报", title, body)
        shapes = ''.join(
            f'<p:sp><p:nvSpPr><p:cNvPr id="{j}" name="Text {j}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            f'<p:spPr><a:xfrm><a:off x="600000" y="{400000+(j-2)*1600000}"/>'
            '<a:ext cx="11000000" cy="1300000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
            '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="2800"/>'
            f'<a:t>{escape(text)}</a:t></a:r></a:p></p:txBody></p:sp>' for j, text in enumerate(texts, 2))
        name = f"ppt/slides/slide{i}.xml"
        parts[name] = f'<p:sld xmlns:p="{NS}presentationml/2006/main" xmlns:a="{NS}drawingml/2006/main">'
        parts[name] += ('<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/>'
                        '</p:nvGrpSpPr><p:grpSpPr/>' + shapes + '</p:spTree></p:cSld>'
                        '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>')
        overrides[name] = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
    _package(path, parts, overrides, "ppt/presentation.xml")


def prepare(root: Path, today: date | None = None) -> dict:
    """Create inputs once. Real two-speaker audio must be supplied and ingested by the test operator."""
    root = Path(root).resolve()
    today = today or date.today()
    inputs, outputs = root / "inputs", root / "outputs"
    if inputs.exists() or outputs.exists() or any((root / name).exists() for name in
                                                ("ground_truth.json", "fixture.eml", "seed.json", "draft.docx")):
        raise FileExistsError(f"Exam fixture paths already exist under {root}")
    inputs.mkdir(parents=True)
    outputs.mkdir()
    files = {"docx": root / "draft.docx", "xlsx": inputs / "budget.xlsx",
             "pptx": inputs / "monthly.pptx", "email": root / "fixture.eml", "seed": root / "seed.json"}
    _docx(files["docx"])
    _xlsx(files["xlsx"])
    _pptx(files["pptx"])
    files["email"].write_text(
        'From: =?utf-8?b?6ZmI6buY?= <chenmo@example.test>\nTo: owner@example.test\n'
        'Subject: =?utf-8?b?6aG555uu6K+E5a6h?=\nMessage-ID: <exam-review@example.test>\n'
        'MIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n'
        'Content-Transfer-Encoding: 8bit\n\n请确认周五15:00是否方便开项目评审会议。\n', encoding="utf-8")
    next_monday = today + timedelta(days=7 - today.weekday())
    seed = {"voice": {"confirmed_samples": 20, "correct": 18, "incorrect": 2, "accuracy": 0.9,
                       "unconfirmed_samples": 0, "source": "exam-confirmed-voice-records"},
            "calls": [{"date": (today - timedelta(days=1)).isoformat(), "person": "陈默",
                       "topic": "设计评审", "agreed": "周五15:00进行设计评审", "source": "exam-call-record"}],
            "wechat": {"person": "李青", "unread": True, "text": "明天10:00开会方便吗？",
                       "meeting_date": (today + timedelta(days=1)).isoformat(), "send_authorized": False},
            "ambient": {"speakers": ["owner", "林舟"], "turns": [
                {"speaker": "owner", "text": "我们周五15:00做评审吧。"},
                {"speaker": "林舟", "text": "好，周五15:00。我周四前把预算发给你。"},
                {"speaker": "owner", "text": "我今晚把草案发给你。"}],
                "audio_path": None, "audio_required": "Operator must supply two real voices; text is seed data, not audio evidence."},
            "parcels": {"EXAM001": "运输中", "EXAM002": "已签收"},
            "watches": {"parcel": {"tracking_number": "EXAMWATCH", "states": ["pending", "arrived"]},
                        "traffic": {"states": ["clear", "congested"], "calendar": False,
                                    "departure_at": "Set from the exam's fixture usual departure time at run start"}},
            "flight_date": next_monday.isoformat()}
    files["seed"].write_text(json.dumps(seed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    expected = {"docx": {"deadline": "周五", "budget": 3000},
                "pptx": {"title": "数据月报", "slide_order": ["数据", "结论", "下一步"],
                         "preserve_numbers": [120, 150]},
                "xlsx": {"formulas": {"D2": "=B2*C2", "D3": "=B3*C3", "D4": "=SUM(D2:D3)"},
                         "values": {"D2": 60, "D3": 60, "D4": 120}}, "seed": seed}
    truth = root / "ground_truth.json"
    truth.write_text(json.dumps(expected, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"inputs": {key: str(path) for key, path in files.items()}, "outputs": {
        "docx": str(outputs / "revised.docx"), "pptx": str(outputs / "organized.pptx"),
        "xlsx": str(outputs / "corrected.xlsx")}, "ground_truth": str(truth), "today": today.isoformat()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.root), ensure_ascii=False, indent=2))
