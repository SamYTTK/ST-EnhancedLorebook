import os
import re

_base = os.path.dirname(__file__)
with open(os.path.join(_base, 'index.html'), encoding='utf8') as f:
    html = f.read()

ids = re.findall(r'id="([^"]+)"', html)
duplicates = [x for x in set(ids) if ids.count(x) > 1]
print('Duplicates:', duplicates)
