import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export function json(response,value,status=200){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(value));}
export async function createSource({port=0,host='127.0.0.1'}={}){
  const state=JSON.parse(await readFile(new URL('../fixtures/source.json',import.meta.url),'utf8'));
  
  const pages={};
  const server=http.createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,'http://local.test');let text='';
      for await(const chunk of request){text+=chunk;if(text.length>8*1024*1024){json(response,{error:'控制请求过大'},413);return;}}
      let body={};if(text){try{body=JSON.parse(text);}catch{return json(response,{error:'JSON无效'},400);}}
      if(url.pathname==='/health')return json(response,{status:'ok'});
      if(url.pathname==='/state'||url.pathname==='/inventory')return json(response,state);
      if(url.pathname==='/control'&&request.method==='POST'){Object.assign(state,body); return json(response,state);}
      if(Object.hasOwn(pages,url.pathname)){response.setHeader('Content-Type','text/html; charset=utf-8');return response.end(await readFile(new URL('../public/'+pages[url.pathname],import.meta.url)));}
      
    if(url.pathname.startsWith('/packages/')){
      const name=decodeURIComponent(url.pathname.slice('/packages/'.length));if(!['app','helper','win-tool','host'].includes(name))return json(response,{error:'未知包'},404);
      const archive=Buffer.from(`archive:${name}:1.0.0`);const integrity='sha512-'+createHash('sha512').update(archive).digest('base64');
      const base={name,version:'1.0.0',dist:{tarball:`/archives/${encodeURIComponent(name)}`,integrity}};
      if(name==='app')Object.assign(base,{dependencies:{helper:'^1.0.0'},optionalDependencies:{'win-tool':'1.0.0'},peerDependencies:{host:'^2.0.0'},deprecated:state.withdrawn?'已撤回':undefined});
      if(name==='helper')base.dependencies={app:'1.0.0'};if(name==='win-tool')base.os=['win32'];
      return json(response,{name,'dist-tags':{latest:state.tag},versions:{'1.0.0':base,'2.0.0':{...base,version:'2.0.0',dist:{tarball:`/archives/${encodeURIComponent(name)}-v2`,integrity:'sha512-'+createHash('sha512').update(`archive:${name}:2.0.0`).digest('base64')}}}});
    }
    if(url.pathname.startsWith('/archives/')){const name=decodeURIComponent(url.pathname.split('/').pop());response.setHeader('Content-Type','application/octet-stream');return response.end(state.badArchive?'损坏归档':`archive:${name.replace(/-v2$/,'')}:${name.endsWith('-v2')?'2.0.0':'1.0.0'}`);}

      return json(response,{error:'资源不存在'},404);
    }catch(error){if(!response.headersSent)json(response,{error:error.message},500);else response.destroy();}
  });
  await new Promise(resolve=>server.listen(port,host,resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,state,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
