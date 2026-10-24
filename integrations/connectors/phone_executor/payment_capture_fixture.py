"""Explicit capture metadata for synthetic payment test observations only."""
import io
from functools import lru_cache
import xml.etree.ElementTree as ET
from PIL import Image, PngImagePlugin
import server


def hierarchy(xml, viewport=(1000, 1600)):
    """Declare known synthetic viewport without replacing supplied producer metadata."""
    root = ET.fromstring(xml)
    if viewport is not None:
        root.attrib.setdefault('width', str(viewport[0]))
        root.attrib.setdefault('height', str(viewport[1]))
    else:
        root.attrib.pop('width', None)
        root.attrib.pop('height', None)
    return ET.tostring(root)


@lru_cache(maxsize=128)
def frame(viewport=(1000, 1600), raw=b'frame'):
    """Encode a synthetic image at the screenshot producer's declared resize."""
    width, height = viewport
    scale = min(1, 1600 / max(viewport))
    size = (int(width * scale + .5), int(height * scale + .5))
    output = io.BytesIO()
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text('synthetic-fixture', bytes(raw).hex())
    Image.new('RGB', size, 'white').save(output, format='PNG', pnginfo=metadata)
    return server._ScreenImage(output.getvalue(), viewport)
