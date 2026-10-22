#!/usr/bin/env python3
"""End-to-end helper protocol, semantic retrieval, OCR and thumbnail checks."""
import base64
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from PIL import Image,ImageDraw,ImageFont

repo=Path(__file__).resolve().parents[1]
models=Path(sys.argv[1])
with tempfile.TemporaryDirectory() as folder:
 root=Path(folder)
 (root/'models').symlink_to(models)
 with (repo.parent/'work/local-search.log').open('w') as log:
  process=subprocess.Popen([sys.executable,str(repo/'history_service.py'),folder],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True)
  serial=0
  def request(op,**fields):
   global serial
   serial+=1
   process.stdin.write(json.dumps({'id':serial,'op':op,**fields})+'\n');process.stdin.flush()
   response=json.loads(process.stdout.readline())
   assert 'error' not in response,response
   return response['result']
  for text in ['The automobile requires a mechanic to replace its engine.','Fresh tomatoes and basil make a delicious pasta sauce.']:
   request('add',mimetype='text/plain',data=base64.b64encode(text.encode()).decode())
  image=Image.new('RGB',(600,120),'white')
  ImageDraw.Draw(image).text((20,25),'Clipboard search example',font=ImageFont.load_default(size=32),fill='black')
  file=root/'fixture.png';image.save(file)
  request('add',mimetype='image/png',data=base64.b64encode(file.read_bytes()).decode())
  ready=False
  deadline=time.monotonic()+45
  while time.monotonic()<deadline:
   stats=request('stats')
   ocr=request('query',q='Clipboard search')
   if stats['semantic']=='ready' and ocr['items']:
    ready=True;break
   time.sleep(.5)
  assert ready,stats
  reply=request('query',q='car repairs',semantic=True)
  assert reply['items'][0]['id']==1,reply
  assert Path(ocr['items'][0]['thumbnail']).exists()
  assert len(ocr['items'])==1
  request('delete',entry=3)
  assert not request('query',q='Clipboard search')['items']
  for i in range(80):
   request('add',mimetype='text/plain',data=base64.b64encode(f'Automobile engine maintenance note {i}'.encode()).decode())
  first=request('query',q='automobile',limit=30,semantic=True)
  second=request('query',q='automobile',limit=30,offset=30,semantic=True)
  assert first['total']>=81 and second['total']==first['total']
  assert not ({e['id'] for e in first['items']} & {e['id'] for e in second['items']})
  process.stdin.close();process.wait(timeout=5)
  assert process.returncode==0
  print('PASS: helper protocol, local semantic synonyms, screenshot OCR, thumbnails, deletion, and lazy semantic windows')
