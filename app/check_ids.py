import os
import re

_base = os.path.dirname(__file__)
with open(os.path.join(_base, 'index.html'), encoding='utf8') as f:
    html = f.read()

with open(os.path.join(_base, 'app.js'), encoding='utf8') as f:
    js = f.read()

html_ids = set(re.findall(r'id="([^"]+)"', html))
js_ids = set(re.findall(r"getElementById\('([^']+)'\)", js))

missing = js_ids - html_ids
print("Missing in HTML:", missing)
