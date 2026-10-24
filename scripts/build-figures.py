from pathlib import Path
import json, html, subprocess, re, textwrap
P=Path(__file__).resolve().parent.parent;A=P/'assets';A.mkdir(exist_ok=True)
def load(n):return json.loads((P/n).read_text())
sys=load('model/system.json');sys['views']=[v for v in sys['views'] if v['id']!='social-focus'];nodes={x['id']:x for x in sys['nodes']};rels={r['id']:r for r in sys['relations']}
def esc(s):return html.escape(str(s),quote=True)
def wrap(s,width=22):return '&#160;' if not s else '<BR/>'.join(esc(s[i:i+width]) for i in range(0,len(s),width))
def box(n):
 kind=n['kind']; external=kind.startswith('External');col='#eef4fb' if external else '#edf7f4';border='#6683ae' if external else '#35857d'
 if kind=='Person':col='#fff3e0';border='#b78a3e'
 return f'''<<TABLE BORDER="1" COLOR="{border}" CELLBORDER="0" CELLSPACING="0" CELLPADDING="9" BGCOLOR="{col}"><TR><TD><FONT POINT-SIZE="11" COLOR="#586d80">«{esc(kind)}»</FONT></TD></TR><TR><TD><B><FONT POINT-SIZE="16">{wrap(n['label'],20)}</FONT></B></TD></TR><TR><TD><FONT POINT-SIZE="11">{wrap(n['tech'],30)}</FONT></TD></TR><TR><TD><FONT POINT-SIZE="12">{wrap(n['role'],22)}</FONT></TD></TR></TABLE>>'''
def render(name,dot):
 (A/(name+'.dot')).write_text(dot)
 r=subprocess.run(['dot','-Tsvg'],input=dot,text=True,capture_output=True)
 if r.returncode:raise Exception(name+r.stderr)
 svg=r.stdout[ r.stdout.index('<svg'): ];svg=re.sub(r'<title>.*?</title>','',svg,flags=re.S)
 svg=svg.replace('font-family="Noto Sans CJK JP"','font-family="Noto Sans CJK JP, sans-serif"')
 (A/(name+'.svg')).write_text(svg);return svg
base='graph [rankdir=LR,bgcolor="transparent",pad="0.35",nodesep="0.65",ranksep="1.3",splines=spline,outputorder=edgesfirst]; node [shape=plain,fontname="Noto Sans CJK JP"]; edge [fontname="Noto Sans CJK JP",fontsize=11,arrowsize=0.75,penwidth=1.3];'
for v in sys['views']:
 lines=['digraph G {',base]
 if v['boundary']:
  lines+=['subgraph cluster_scope { style="rounded,dashed";color="#b5c9d4";label="'+esc(v['scope'])+' / '+v['level']+'";fontname="Noto Sans CJK JP";fontsize=12;']
  for i in v['boundary']:lines.append(f'"{i}";')
  lines.append('}')
 for i in v['nodes']:
  lines.append(f'"{i}" [label={box(nodes[i])},URL="#node={i}",target="_self"];')
 for rid in v['relations']:
  r=rels[rid];a=r['source'];b=r['target']
  label=f'''<<FONT COLOR="#254e76">{wrap(r['send'],20)}<BR/><FONT POINT-SIZE="9">{esc(r['protocol'])} · {r['contract']}</FONT></FONT>>'''
  ret=f'''<<FONT COLOR="#18775f">{wrap(r['receive'],20)}<BR/><FONT POINT-SIZE="9">応答 · {r['contract']}</FONT></FONT>>'''
  lines.append(f'"{a}" -> "{b}" [label={label},color="#315a80",URL="#edge={rid}"];')
  lines.append(f'"{b}" -> "{a}" [label={ret},color="#2b8c71",style=dashed,constraint=false,URL="#edge={rid}"];')
 lines.append('}');render(v['id'],'\n'.join(lines))
# Additional focused SNS component view shares exactly the same model.
v=dict(id='social-focus',title='C3｜SNSの責任分担だけを拡大',level='C4 Component',scope='shared',nodes=['web-shared','auth','social','groups','repository','db'],relations=['C01','C03','C04','C07','C09','C10','C12'],boundary=['auth','social','groups','repository'],note='SNS投稿とグループ認可の部分だけを抽出した同じC3モデル。別システムではありません。')
sys['views'].append(v)
lines=['digraph G {',base]
for i in v['nodes']:lines.append(f'"{i}" [label={box(nodes[i])},URL="#node={i}"];')
for rid in v['relations']:
 r=rels[rid]
 for direction in ['request','response']:
  a,b=(r['source'],r['target']) if direction=='request' else (r['target'],r['source']);text=r['send'] if direction=='request' else r['receive'];col='#315a80' if direction=='request' else '#2b8c71';extra='' if direction=='request' else ',style=dashed,constraint=false'
  lines.append(f'"{a}" -> "{b}" [label=<{wrap(text,19)}<BR/><FONT POINT-SIZE="9">{esc(r["protocol"])} · {r["contract"]}</FONT>>,color="{col}",URL="#edge={rid}"{extra}];')
lines.append('}');render('social-focus','\n'.join(lines));(P/'model/system.json').write_text(json.dumps(sys,ensure_ascii=False,indent=2)+'\n')
# C4 Code scoped data model
m=load('model/data-model.json');lines=['digraph D {',base.replace('rankdir=LR','rankdir=LR')]
for t in m['tables']:
 label='<<TABLE BORDER="1" COLOR="#5d7790" CELLBORDER="0" CELLSPACING="0" CELLPADDING="8" BGCOLOR="white"><TR><TD BGCOLOR="#e9f0f6"><FONT POINT-SIZE="10">«table»</FONT><BR/><B>'+esc(t['id'])+'</B><BR/>'+esc(t['label'])+'</TD></TR>'+''.join('<TR><TD ALIGN="LEFT"><FONT POINT-SIZE="10">'+wrap(f,36)+'</FONT></TD></TR>' for f in t['fields'])+'</TABLE>>'
 lines.append(f'"{t["id"]}" [label={label},URL="#table={t["id"]}"];')
for x in m['links']:
 lines.append(f'"{x["source"]}" -> "{x["target"]}" [arrowhead=none,taillabel="{x["fromCard"]}",headlabel="{x["toCard"]}",label="{x["field"]}",fontsize=9,color="#6e8292"];')
lines.append('}');render('data-model','\n'.join(lines))
# Focused social tables retains cardinalities for initial view.
subset={'users','trips','posts','post_snapshots','groups','group_members'}
lines=['digraph D {',base]
for t in m['tables']:
 if t['id'] not in subset:continue
 label='<<TABLE BORDER="1" COLOR="#5d7790" CELLBORDER="0" CELLSPACING="0" CELLPADDING="8" BGCOLOR="white"><TR><TD BGCOLOR="#e9f0f6"><B>'+esc(t['id'])+'</B><BR/>'+esc(t['label'])+'</TD></TR>'+''.join('<TR><TD ALIGN="LEFT"><FONT POINT-SIZE="11">'+wrap(f,34)+'</FONT></TD></TR>' for f in t['fields'])+'</TABLE>>'
 lines.append(f'"{t["id"]}" [label={label},URL="#table={t["id"]}"];')
for x in m['links']:
 if x['source'] in subset and x['target'] in subset:lines.append(f'"{x["source"]}" -> "{x["target"]}" [arrowhead=none,taillabel="{x["fromCard"]}",headlabel="{x["toCard"]}",label="{x["field"]}",fontsize=10];')
lines.append('}');render('data-social','\n'.join(lines))
m=load('model/code-model.json');lines=['digraph D {',base]
for t in m['types']:
 label='<<TABLE BORDER="1" COLOR="#75618f" CELLBORDER="0" CELLSPACING="0" CELLPADDING="9" BGCOLOR="white"><TR><TD BGCOLOR="#f0eaf8"><FONT POINT-SIZE="10">«'+esc(t['kind'])+'»</FONT><BR/><B>'+esc(t['id'])+'</B></TD></TR>'+''.join('<TR><TD ALIGN="LEFT"><FONT POINT-SIZE="11">'+wrap(f,40)+'</FONT></TD></TR>' for f in t['fields'])+'</TABLE>>'
 lines.append(f'"{t["id"]}" [label={label},URL="#type={t["id"]}"];')
for x in m['links']:lines.append(f'"{x["source"]}" -> "{x["target"]}" [label="{x["label"]}",color="#705888"];')
lines.append('}');render('claude-code','\n'.join(lines))
# Deployment diagram: concrete instances, not additional logical components.
dep='''digraph G {
graph [rankdir=LR,bgcolor="transparent",pad=.4,nodesep=.7,ranksep=1.0];node [shape=box,style="rounded,filled",fillcolor="#edf5f9",fontname="Noto Sans CJK JP",fontsize=13,margin=.2];edge [fontname="Noto Sans CJK JP",fontsize=11];
subgraph cluster_user {label="別の利用者の端末";fontname="Noto Sans CJK JP";remote [label="共有Web画面\n閲覧・編集・SNS"]}
tunnel [label="HTTPS公開入口\nCloudflare Tunnel等"];
subgraph cluster_pc {label="本人のPC（初期デモ配置）";fontname="Noto Sans CJK JP";style=dashed;color="#9eafbc";
 localbrowser [label="本人のブラウザ\n127.0.0.1:4311"];
 local [label="本人用App Server\n127.0.0.1:4311",URL="#node=personal",fillcolor="#f0eaf8"];
 cli [label="公式Claude Code\n本人の認証・専用cwd",URL="#node=cli",fillcolor="#f0eaf8"];
 shared [label="共有アプリサーバー\n127.0.0.1:4310",URL="#node=shared"];
 db [label="共通DB\n非公開の永続ファイル",URL="#node=db",shape=cylinder];
 localbrowser -> local [label="HTTP：生成条件・本人cookie"];
 local -> localbrowser [label="202 jobId／候補・結果",style=dashed,color="#288467",constraint=false];
 local -> cli [label="stdin：旅行指示"];
 cli -> local [label="stdout：構造化結果",style=dashed,color="#288467",constraint=false];
 local -> shared [label="本人のアプリ認証\n情報取得・候補保存"];
 shared -> local [label="JSON：情報・保存ID",style=dashed,color="#288467",constraint=false];
 shared -> db [label="SQL・transaction"];
 db -> shared [label="rows・revision",style=dashed,color="#288467",constraint=false];
}
cloud [label="Anthropic側\nClaudeモデル",URL="#node=anthropic"];
remote -> tunnel [label="HTTPS：共有操作"];
tunnel -> remote [label="画面・許可された結果",style=dashed,color="#288467",constraint=false];
tunnel -> shared [label="4310へのみ転送"];
shared -> tunnel [label="HTTP応答",style=dashed,color="#288467",constraint=false];
cli -> cloud [label="公式CLIのHTTPS依頼"];
cloud -> cli [label="モデル応答",style=dashed,color="#288467",constraint=false];
}'''
render('deployment',dep)
# Dynamic: C4's sequence-style view, using stable container identities.
for f in load('model/workflows.json'):
 actors=f['actors'];col=285;left=70;width=left*2+col*(len(actors)-1)+240;x={a:left+120+i*col for i,a in enumerate(actors)}
 stepH=98;height=140+stepH*len(f['steps'])+45
 z=[f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" role="img" aria-label="{esc(f["title"])}">', '<defs><marker id="req" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#315a80"/></marker><marker id="res" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#288467"/></marker></defs>','<rect width="100%" height="100%" fill="#fff"/>']
 for a in actors:
  no=nodes[a];xx=x[a]
  z += [f'<a href="#node={a}"><rect x="{xx-115}" y="15" width="230" height="77" rx="8" fill="#edf4f8" stroke="#a6bacb"/><text x="{xx}" y="40" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#6c7d8b">«{esc(no["kind"])}»</text><text x="{xx}" y="65" text-anchor="middle" font-family="sans-serif" font-size="15" font-weight="700">{esc(no["label"])}</text></a>', f'<line x1="{xx}" y1="92" x2="{xx}" y2="{height-15}" stroke="#b7c6d2" stroke-dasharray="5 6"/>']
 for i,st in enumerate(f['steps']):
  yy=145+i*stepH;direction=st['direction'];title=f"{st['number']:02d}  {st['label']}";color='#288467' if direction=='response' else '#315a80';marker='res' if direction=='response' else 'req';dash=' stroke-dasharray="7 5"' if direction=='response' else ''
  z.append(f'<g><a href="#step={f["id"]}:{i}">')
  if direction=='self':
   xx=x[st['actor']];z.append(f'<path d="M{xx},{yy} h95 v24 h-95" fill="none" stroke="{color}" stroke-width="1.8" marker-end="url(#req)"/>');tx=xx+10;anchor='start';maxchar=23
  else:
   rr=rels[st['relation']];aa,bb=(rr['source'],rr['target']) if direction=='request' else (rr['target'],rr['source']);xa=x[aa];xb=x[bb]
   z.append(f'<rect x="{min(xa,xb)}" y="{yy-53}" width="{abs(xb-xa)}" height="70" fill="transparent"/><line x1="{xa}" x2="{xb}" y1="{yy}" y2="{yy}" stroke="{color}" stroke-width="2"{dash} marker-end="url(#{marker})"/>');tx=(xa+xb)/2;anchor='middle';maxchar=max(19,int(abs(xa-xb)/14))
  txtlines=[title[j:j+maxchar] for j in range(0,len(title),maxchar)]
  for j,t in enumerate(txtlines):z.append(f'<text x="{tx}" y="{yy-36+j*17}" text-anchor="{anchor}" fill="{color}" font-family="sans-serif" font-size="13">{esc(t)}</text>')
  z.append(f'<text x="{tx}" y="{yy+20 if direction!="self" else yy+46}" text-anchor="{anchor}" font-family="sans-serif" font-size="10" fill="#687c8c">{("内部処理" if direction=="self" else st["contract"])} · 選択で入出力の実例</text></a></g>')
 z.append('</svg>');(A/(f['id']+'.svg')).write_text(''.join(z))
print('created',len(list(A.glob('*.svg'))),'SVG diagrams')

import hashlib
h=hashlib.sha256()
for name in ["system","contracts","workflows","data-model","code-model"]:
 h.update((P/"model"/(name+".json")).read_bytes())
(A/"model.sha256").write_text(h.hexdigest()+"\n")
