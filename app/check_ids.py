import re

with open('d:/Games/OTHERS/SillyTavern-Launcher/SillyTavern/public/scripts/extensions/third-party/ST-EnhancedLorebook/app/index.html', encoding='utf8') as f:
    html = f.read()

with open('d:/Games/OTHERS/SillyTavern-Launcher/SillyTavern/public/scripts/extensions/third-party/ST-EnhancedLorebook/app/app.js', encoding='utf8') as f:
    js = f.read()

html_ids = set(re.findall(r'id="([^"]+)"', html))
js_ids = set(re.findall(r"getElementById\('([^']+)'\)", js))

missing = js_ids - html_ids
print("Missing in HTML:", missing)
