import re

with open('d:/Games/OTHERS/SillyTavern-Launcher/SillyTavern/public/scripts/extensions/third-party/ST-EnhancedLorebook/app/index.html', encoding='utf8') as f:
    html = f.read()

ids = re.findall(r'id="([^"]+)"', html)
duplicates = [x for x in set(ids) if ids.count(x) > 1]
print('Duplicates:', duplicates)
