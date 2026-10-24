"""Adding a sheet to an existing workbook keeps its workbook-level style semantics.

Runs in the workshop image, where Office edits run (python3-openpyxl), via compose.workshop-kernel.yaml.
"""
from decimal import Decimal, ROUND_HALF_UP
import xml.etree.ElementTree as ET
from zipfile import ZipFile

import pytest

openpyxl = pytest.importorskip('openpyxl')

MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.'
NS = {'s': MAIN}
EXCEL_DEFAULT_FONT = {'name': {'val': 'Calibri'}, 'family': {'val': '2'}, 'color': {'theme': '1'},
                      'sz': {'val': '11'}, 'scheme': {'val': 'minor'}}
# Hand-built styles fixture exercises the package editor's namespace handling.
HAND_BUILT_STYLES = (
    f'<styleSheet xmlns="{MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.00000"/></numFmts>'
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')


def sheet_xml(rows):
    cells = ''.join(f'<row r="{r}">' + ''.join(f'<c r="{c}{r}"><v>{v}</v></c>' for c, v in row) + '</row>'
                    for r, row in rows)
    return f'<worksheet xmlns="{MAIN}"><sheetData>{cells}</sheetData></worksheet>'


def unstyled_workbook(path, extra=None):
    """Two numeric sheets and a defined name, with no styles or theme part, like minimal generators write."""
    first = [(r, [('A', r - 1), ('B', f'{r - 1}.12345'), ('F', f'{r}.25'), ('I', f'0.{r - 1}')]) for r in range(2, 12)]
    second = [(r, [('A', r - 1), ('B', f'{101 - r}.00001')]) for r in range(2, 12)]
    sheets = ''.join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="{CT}worksheet+xml"/>' for i in (1, 2))
    parts = {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        f'<Override PartName="/xl/workbook.xml" ContentType="{CT}sheet.main+xml"/>{sheets}</Types>',
        '_rels/.rels': f'<Relationships xmlns="{PKG}"><Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': f'<workbook xmlns="{MAIN}" xmlns:r="{REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/>'
        '<sheet name="Sheet2" sheetId="2" r:id="rId2"/></sheets>'
        '<definedNames><definedName name="Inputs">Sheet1!$A$2:$I$11</definedName></definedNames></workbook>',
        'xl/_rels/workbook.xml.rels': f'<Relationships xmlns="{PKG}">' + ''.join(
            f'<Relationship Id="rId{i}" Type="{REL}/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in (1, 2))
        + '</Relationships>',
        'xl/worksheets/sheet1.xml': sheet_xml(first),
        'xl/worksheets/sheet2.xml': sheet_xml(second),
        **(extra or {}),
    }
    with ZipFile(path, 'w') as archive:
        for name, text in parts.items():
            archive.writestr(name, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + text)
    return path


def default_font(path):
    """The font every unstyled cell resolves to; without a styles part Excel uses its implicit default."""
    with ZipFile(path) as archive:
        if 'xl/styles.xml' not in archive.namelist():
            return EXCEL_DEFAULT_FONT
        styles = ET.fromstring(archive.read('xl/styles.xml'))
    font_id = int(styles.find('s:cellXfs/s:xf', NS).get('fontId', '0'))
    return {node.tag.rsplit('}', 1)[1]: node.attrib for node in styles.findall('s:fonts/s:font', NS)[font_id]}


def workbook_semantics(path):
    with ZipFile(path) as archive:
        book = ET.fromstring(archive.read('xl/workbook.xml'))
        theme = archive.read('xl/theme/theme1.xml') if 'xl/theme/theme1.xml' in archive.namelist() else None
    pr = book.find('s:workbookPr', NS)
    return {'sheets': [s.get('name') for s in book.find('s:sheets', NS)],
            'names': {n.get('name'): n.text for n in book.findall('s:definedNames/s:definedName', NS)},
            'date1904': (pr.get('date1904') if pr is not None else None) in ('1', 'true'),
            'theme': theme}


def cell_semantics(path, titles):
    book = openpyxl.load_workbook(path)
    style = lambda c: tuple(ET.tostring(part.to_tree()) for part in (c.font, c.fill, c.border)) + (c.number_format,)
    return {t: {c.coordinate: (c.value, style(c)) for row in book[t].iter_rows() for c in row if c.value is not None}
            for t in titles}


def add_result_sheet(source, output):
    """The taught procedure: load the original package, append a sheet, save as a new file."""
    book = openpyxl.load_workbook(source)
    first, second = book['Sheet1'], book['Sheet2']
    sheet = book.create_sheet('Sheet3')
    expected = {}
    for r in range(2, first.max_row + 1):
        value = (Decimal(str(first.cell(r, 2).value)) * Decimal(str(first.cell(r, 6).value))
                 - Decimal(str(first.cell(r, 9).value)) + Decimal(str(second.cell(r, 2).value)))
        value = float(value.quantize(Decimal('0.00001'), rounding=ROUND_HALF_UP))
        sheet.cell(r, 1, first.cell(r, 1).value)
        sheet.cell(r, 2, value).number_format = '0.00000'
        expected[r] = value
    book.save(output)
    return expected


def test_a_hand_written_styles_part_changes_the_implicit_default_font(tmp_path):
    source = unstyled_workbook(tmp_path / 'in.xlsx')
    rebuilt = unstyled_workbook(tmp_path / 'rebuilt.xlsx', {'xl/styles.xml': HAND_BUILT_STYLES})
    assert default_font(source) == EXCEL_DEFAULT_FONT
    assert default_font(rebuilt) == {'sz': {'val': '11'}, 'name': {'val': 'Calibri'}}
    # Byte-identical sheet XML hides this; resolved cell styles show it.
    with ZipFile(source) as a, ZipFile(rebuilt) as b:
        assert a.read('xl/worksheets/sheet1.xml') == b.read('xl/worksheets/sheet1.xml')
    assert cell_semantics(rebuilt, ['Sheet1']) != cell_semantics(source, ['Sheet1'])


def test_appending_a_sheet_keeps_workbook_level_semantics_without_a_styles_part(tmp_path):
    source = unstyled_workbook(tmp_path / 'in.xlsx')
    output = tmp_path / 'out.xlsx'
    expected = add_result_sheet(source, output)

    assert default_font(output) == EXCEL_DEFAULT_FONT
    before, after = workbook_semantics(source), workbook_semantics(output)
    assert after['sheets'] == before['sheets'] + ['Sheet3']
    assert after['names'] == before['names'] == {'Inputs': 'Sheet1!$A$2:$I$11'}
    assert after['date1904'] == before['date1904'] is False
    assert cell_semantics(output, ['Sheet1', 'Sheet2']) == cell_semantics(source, ['Sheet1', 'Sheet2'])
    result = openpyxl.load_workbook(output)['Sheet3']
    assert {r: result.cell(r, 2).value for r in expected} == expected
    assert {result.cell(r, 2).number_format for r in expected} == {'0.00000'}
    assert expected[2] == 101.42777


def test_appending_a_sheet_keeps_an_existing_theme_and_cell_styles(tmp_path):
    styled = openpyxl.Workbook()
    first = styled.active
    first.title = 'Sheet1'
    second = styled.create_sheet('Sheet2')
    for r in range(2, 6):
        first.cell(r, 1, r - 1).font = openpyxl.styles.Font(name='宋体', sz=12, bold=True)
        first.cell(r, 2, r + 0.12345).number_format = '0.000'
        first.cell(r, 6, r + 0.25).fill = openpyxl.styles.PatternFill('solid', fgColor='FFFF00')
        first.cell(r, 9, r / 10)
        second.cell(r, 2, 100 - r + 0.00001)
    source = tmp_path / 'styled.xlsx'
    styled.save(source)
    output = tmp_path / 'out.xlsx'
    add_result_sheet(source, output)

    before, after = workbook_semantics(source), workbook_semantics(output)
    assert after['theme'] == before['theme'] is not None
    assert default_font(output) == default_font(source) == EXCEL_DEFAULT_FONT
    assert cell_semantics(output, ['Sheet1', 'Sheet2']) == cell_semantics(source, ['Sheet1', 'Sheet2'])
