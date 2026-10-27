# Prüft alle Übersetzungen und baut daraus docs/lang.js (und setzt Deutsch in docs/index.html ein).
# Aufruf: python3 build.py
import json, re, glob, os, sys
D=os.path.dirname(os.path.abspath(__file__))
DOCS=os.path.join(os.path.dirname(D),'docs')
de=json.load(open(os.path.join(D,'de.json'),encoding='utf-8'))
NEED={'en':['one','other'],'es':['one','other'],'fr':['one','other'],'it':['one','other'],'pt':['one','other'],'nl':['one','other'],
      'pl':['one','few','many','other'],'tr':['one','other'],'ru':['one','few','many','other'],'uk':['one','few','many','other'],
      'ar':['zero','one','two','few','many','other'],'hi':['one','other'],'bn':['one','other'],'ur':['one','other'],
      'zh':['other'],'ja':['other'],'ko':['other'],'id':['other'],'vi':['other']}
ph=lambda s:set(re.findall(r'\{(\w+)\}',s))
problems=[]; out={}
for f in sorted(glob.glob(os.path.join(D,'*.json'))):
    code=os.path.basename(f)[:-5]
    if code=='de': continue
    d=json.load(open(f,encoding='utf-8'))
    for k in de:
        if k not in d: problems.append(f'{code}: fehlt {k}'); continue
        v, src = d[k], de[k]
        srcph = ph(src['other']) if isinstance(src,dict) else ph(src)
        if isinstance(src,dict):
            if not isinstance(v,dict): problems.append(f'{code}: {k} braucht Mehrzahl-Formen'); continue
            for cat in NEED[code]:
                if cat not in v: problems.append(f'{code}: {k} ohne „{cat}“')
            for cat,txt in v.items():
                miss=srcph-ph(txt)-({'n'} if cat in ('one','zero','two') else set())
                if miss or ph(txt)-srcph: problems.append(f'{code}: {k}/{cat} Platzhalter {sorted(ph(txt))} statt {sorted(srcph)}')
        else:
            if not isinstance(v,str): problems.append(f'{code}: {k} sollte Text sein'); continue
            if ph(v)!=srcph: problems.append(f'{code}: {k} Platzhalter {sorted(ph(v))} statt {sorted(srcph)}')
            if not v.strip(): problems.append(f'{code}: {k} leer')
    for k in d:
        if k not in de: problems.append(f'{code}: unbekannt {k}')
    out[code]={k:d[k] for k in de if k in d}
if problems:
    print('\n'.join(problems[:80])); print(len(problems),'Probleme'); sys.exit(1)
js='// Übersetzungen für Finanzo (automatisch erzeugt aus finanzo/i18n/*.json – nicht von Hand ändern)\nwindow.FINANZO_LANGS='+json.dumps(out,ensure_ascii=False,separators=(',',':'))+';\n'
open(os.path.join(DOCS,'lang.js'),'w',encoding='utf-8').write(js)
# Deutsch in index.html aktualisieren
p=os.path.join(DOCS,'index.html'); s=open(p,encoding='utf-8').read()
s2=re.sub(r'/\*DE\*/const DE=.*?;/\*/DE\*/','/*DE*/const DE='+json.dumps(de,ensure_ascii=False,separators=(',',':')).replace('\\','\\\\')+';/*/DE*/',s,count=1,flags=re.S)
open(p,'w',encoding='utf-8').write(s2)
print('ok:',', '.join(sorted(out)),f'({len(out)} Sprachen, {len(de)} Texte, lang.js {len(js)//1024} KB)')
