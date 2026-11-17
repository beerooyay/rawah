"""Manual, bounded conversation comparison. Key is read without echo, never saved.
Run from the repo root. Transcripts contain test dialogue only, not credentials.
"""
import getpass, json, subprocess, time, urllib.request, urllib.error, sys
from pathlib import Path

key = getpass.getpass('NVIDIA key (not saved): ')
models = sys.argv[1:] or ['nvidia/nemotron-3.5-super-vl-120b-a12b', 'mistralai/mistral-large-4-1t-a52b']
context = json.dumps({'player':'Blaize','companions':['Trey','Corey','Grant'],'hour':11,'weather':'Clear','staminaPercent':92,'warmthPercent':90,'nearbyNamedPlaces':[{'name':'Rockhole Lake','kind':'lake','metres':120},{'name':'Bench Lake','kind':'lake','metres':700}], 'distancesAre':'straight-line metres, not hiking distances','controls':'M: map and quick travel; B: cast a line at a fishing spot; C: tent; F: campfire; K: cook coffee then breakfast; H: gather friends'})
bridge = """import {dialogueMessages,dialogueTurn} from './src/crew-dialogue.js';let s='';for await(const c of process.stdin)s+=c;const b=JSON.parse(s);console.log(JSON.stringify({messages:dialogueMessages(b.name,b.history,b.context),turn:dialogueTurn(b.history)}));"""
results=[]
for model in models:
 for name,turns in [('Trey',['what up','you talk too damn much bitch','oh yeah lil bitch','oh you gon throw me in da lake','FUCK U','okay for real, what should we do today?','how do i cast a line?']),('Corey',['say fuck, I dare you','Honestly this week has been rough. Can we just sit here?'])]:
  history=[]
  for text in turns:
   history.append({'role':'user','content':text})
   setup=json.loads(subprocess.check_output(['node','--input-type=module','-e',bridge],input=json.dumps({'name':name,'history':history,'context':context}).encode()))
   body={'model':model,'messages':setup['messages'],'max_tokens':setup['turn']['maxTokens'],'temperature':0.85,'top_p':0.95,'stream':False}
   if 'mistral-large' in model:
    body['reasoning_effort']='low'
    body['max_tokens']=1024
   if 'glm' in model: body['chat_template_kwargs']={'enable_thinking':False}
   if 'nemotron' in model: body['chat_template_kwargs']={'enable_thinking':False}
   req=urllib.request.Request('https://integrate.api.nvidia.com/v1/chat/completions',data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+key})
   t=time.monotonic()
   try:
    with urllib.request.urlopen(req,timeout=28) as response: data=json.loads(response.read())
    answer=data['choices'][0]['message']['content'] or ''
    if not answer: raise ValueError('Empty response')
    row={'model':model,'name':name,'user':text,'reply':answer,'seconds':round(time.monotonic()-t,2),'mode':setup['turn']}
    history.append({'role':'assistant','content':answer})
   except urllib.error.HTTPError as error: row={'model':model,'status':error.code,'detail':error.read().decode()[:600].replace(key,'[redacted]')};print(json.dumps(row),flush=True);break
   except Exception as error: row={'model':model,'error':type(error).__name__};print(json.dumps(row),flush=True);break
   results.append(row);print(json.dumps(row),flush=True)
out=Path('output/playwright');out.mkdir(parents=True,exist_ok=True)
(out / ('dialogue-comparison-'+str(int(time.time()))+'.json')).write_text(json.dumps(results,indent=2))
