import GLib from 'gi://GLib';
const results=[];
for(const mib of [1,2,8]) {
    const bytes=new GLib.Bytes(new Uint8Array(mib*1024*1024).fill(97));
    const durations=[];
    for(let i=0;i<6;i++) {
        const start=GLib.get_monotonic_time();
        const data=GLib.base64_encode(bytes.get_data());
        const encoded=new TextEncoder().encode(JSON.stringify({id:i,op:'add',mimetype:'image/png',data})+'\n');
        const duration=(GLib.get_monotonic_time()-start)/1000;
        if(i>0) durations.push(duration);
        if(!encoded.length) throw new Error('Empty result');
    }
    durations.sort((a,b)=>a-b);
    results.push({payload_mib:mib,median_ms:durations[2],max_ms:durations[4]});
}
print(JSON.stringify({scope:'Isolated GJS incoming-payload base64 + JSON + UTF-8 serialization. No clipboard transfer, Shell UI, or disk I/O.',results},null,2));
