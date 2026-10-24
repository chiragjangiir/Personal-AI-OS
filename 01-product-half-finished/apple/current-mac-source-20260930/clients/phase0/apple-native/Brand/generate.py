#!/usr/bin/env python3
"""Render the bundled Yim v1.2 V1 vectors. Requires librsvg.

python3 Brand/generate.py --out /path/to/contact-sheet-directory
Vectors are loaded from the bundled assets; no design is inferred here.
"""
import argparse
import base64
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
APPLE = HERE.parent
ROOT = next(p for p in HERE.parents if (p / '.git').exists())
PHONE = APPLE / 'PersonalAIOSPhase0/OpenSource/apple-health-exporter/app'
MAC = APPLE / 'YimiDesktop'
ANDROID = ROOT / '01-product-half-finished/glasses-android/app/src/main/res'
INFO = {'author': 'xcode', 'version': 1}
SVG = 'http://www.w3.org/2000/svg'
ET.register_namespace('', SVG)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def render(source, target, width, height=None, fmt='png'):
    target.parent.mkdir(parents=True, exist_ok=True)
    command = ['rsvg-convert', '-f', fmt, '-w', str(width)]
    if height is not None:
        command += ['-h', str(height)]
    subprocess.run(command + ['-o', str(target), str(source)], check=True)


def imageset(catalog, name, source, width, height=None, dark=None, template=False):
    folder = catalog / (name + '.imageset')
    images = []
    for suffix, vector in [('', source)] + ([('-dark', dark)] if dark else []):
        filename = name + suffix + '.pdf'
        # PDF dimensions are points; librsvg interprets numeric lengths as 96 dpi px.
        render(HERE / 'vectors' / (vector + '.svg'), folder / filename,
               f'{width}pt', f'{height}pt' if height else None, 'pdf')
        item = {'filename': filename, 'idiom': 'universal'}
        if suffix:
            item['appearances'] = [{'appearance': 'luminosity', 'value': 'dark'}]
        images.append(item)
    write_json(folder / 'Contents.json', {'images': images, 'info': INFO, 'properties': {
        'preserves-vector-representation': True,
        'template-rendering-intent': 'template' if template else 'original'}})


def generate(out):
    icons = []
    for catalog in [PHONE / 'App/Assets.xcassets', PHONE / 'Watch/Assets.xcassets',
                    PHONE / 'WatchApp/Assets.xcassets', MAC / 'Assets.xcassets']:
        write_json(catalog / 'Contents.json', {'info': INFO})
        platform = 'ios' if catalog.parent.name == 'App' else 'macos' if catalog.parent == MAC else 'watchos'
        folder = catalog / 'AppIcon.appiconset'
        entries = []
        if platform == 'macos':
            for pt in [16, 32, 128, 256, 512]:
                for scale in [1, 2]:
                    px = pt * scale
                    source = 'macos-classic-' + str(px if px <= 32 else 1024)
                    filename = f'icon_{pt}x{pt}@{scale}x.png'
                    render(HERE / 'vectors' / (source + '.svg'), folder / filename, px, px)
                    entries.append({'idiom': 'mac', 'size': f'{pt}x{pt}', 'scale': f'{scale}x', 'filename': filename})
                    icons.append((f'Mac {pt}pt @{scale}x', folder / filename, px))
        else:
            for appearance in ['default', 'dark', 'tinted'] if platform == 'ios' else ['default']:
                source = f'ios-{appearance}-1024' if platform == 'ios' else 'watchos-1024'
                filename = source + '.png'
                render(HERE / 'vectors' / (source + '.svg'), folder / filename, 1024, 1024)
                entry = {'idiom': 'universal', 'platform': platform, 'size': '1024x1024', 'filename': filename}
                if appearance != 'default':
                    entry['appearances'] = [{'appearance': 'luminosity', 'value': appearance}]
                entries.append(entry)
                icons.append((catalog.parent.name + ' ' + appearance, folder / filename, 1024))
        write_json(folder / 'Contents.json', {'images': entries, 'info': INFO})
        imageset(catalog, 'YimMarkHeader', 'yim-mark-small-on-light', 17, 17, 'yim-mark-small-on-dark')
        if platform == 'macos':
            imageset(catalog, 'YimLockup', 'yim-lockup-horizontal-on-light', 180, dark='yim-lockup-horizontal-on-dark')
        if platform == 'ios':
            imageset(catalog, 'YimLaunch', 'yim-lockup-stacked-on-light', 112, dark='yim-lockup-stacked-on-dark')
            write_json(catalog / 'YimLaunchBackground.colorset/Contents.json', {'info': INFO, 'colors': [
                {'idiom': 'universal', 'color': {'color-space': 'srgb', 'components': {'red': '1', 'green': '1', 'blue': '1', 'alpha': '1'}}},
                {'idiom': 'universal', 'appearances': [{'appearance': 'luminosity', 'value': 'dark'}],
                 'color': {'color-space': 'srgb', 'components': {'red': '0.0196', 'green': '0.02745', 'blue': '0.05098', 'alpha': '1'}}}]})
    imageset(MAC / 'Assets.xcassets', 'YimMenuBar', 'yim-mark-small-mono-black', 18, 18, template=True)
    shutil.copyfile(HERE / 'vectors/macos-classic-1024.svg', MAC / 'Assets/AppIcon.svg')
    for density, px in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]:
        for shape, suffix in [('square', ''), ('round', '_round')]:
            target = ANDROID / f'mipmap-{density}/ic_launcher{suffix}.png'
            render(HERE / f'vectors/android-{shape}.svg', target, px, px)
            icons.append((f'Glasses {density}{suffix}', target, px))
    # Modern Apple catalogs use one 1024 source; include system slot sizes in the sheet.
    with tempfile.TemporaryDirectory() as scratch:
        for platform, sizes, source in [('iPhone', [40, 58, 60, 80, 87, 120, 180], 'ios-default-1024'),
                                        ('watchOS', [48, 55, 58, 66, 80, 87, 88, 92, 100, 102, 108, 172, 196, 216, 234, 258], 'watchos-1024')]:
            for px in sizes:
                target = Path(scratch) / f'{platform}-{px}.png'
                render(HERE / f'vectors/{source}.svg', target, px, px)
                icons.append((platform + ' system size', target, px))
        out.mkdir(parents=True, exist_ok=True)
        sheet = ET.Element(f'{{{SVG}}}svg', width='1200', height=str(((len(icons) + 5) // 6) * 180 + 60))
        ET.SubElement(sheet, 'rect', width='100%', height='100%', fill='#e8ecf4')
        ET.SubElement(sheet, 'text', x='20', y='32', fill='#0A0F1E', style='font:20px sans-serif').text = 'Yim v1.2 V1 — icons and Apple system-size renders'
        for i, (label, path, px) in enumerate(icons):
            x, y = (i % 6) * 200, (i // 6) * 180 + 60
            size = min(px, 120)
            ET.SubElement(sheet, 'image', x=str(x + (200-size)/2), y=str(y), width=str(size), height=str(size),
                          href='data:image/png;base64,' + base64.b64encode(path.read_bytes()).decode())
            ET.SubElement(sheet, 'text', x=str(x+8), y=str(y+144), style='font:12px sans-serif').text = label
            ET.SubElement(sheet, 'text', x=str(x+8), y=str(y+162), style='font:12px sans-serif').text = f'{px} × {px} px'
        svg = out / 'icon-contact-sheet.svg'
        ET.ElementTree(sheet).write(svg, encoding='utf-8', xml_declaration=True)
        render(svg, out / 'icon-contact-sheet.png', 1200)
    print(f'Rendered {len(icons)} icon entries; contact sheet: {out / "icon-contact-sheet.png"}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    generate(parser.parse_args().out)
