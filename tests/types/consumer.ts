import { Ulda, UldaError, SocketIoTransport, type JsonValue } from 'ulda-auth';
import { Ulda as BrowserUlda } from 'ulda-auth/browser';
type Catalog = { notes: { title: string; done: boolean }; stream: { count: number } };
const sdk = new Ulda<Catalog>('https://synthetic.example');
sdk.data.notes.title.update('title');
const title: string = sdk.data.notes.title.get();
const snapshot: Catalog = sdk.snapshot();
sdk.add('notes', { title, done: false });
sdk.on('error', e => { const code: string = e.code; void code; });
sdk.on('trace', e => { const ids: readonly string[] = e.ids; void ids; });
sdk.on('change', e => { if ('id' in e) { const id: string = e.id; void id; } });
new BrowserUlda('https://synthetic.example');
new SocketIoTransport('https://synthetic.example');
new UldaError('CONFLICT');
const dynamic = new Ulda('https://synthetic.example');
const value: JsonValue = dynamic.data.notes.title.get();
dynamic.ref('notes').field('get').update('reserved field');
void snapshot; void value;
// @ts-expect-error unsupported option
new Ulda('https://synthetic.example', { watch: true });
// @ts-expect-error wrong value type
sdk.data.notes.title.update(1);
// @ts-expect-error secrets are not public SDK properties
sdk.origin;
// @ts-expect-error a raw object is not an SDK packet handle
new SocketIoTransport('https://synthetic.example').send({ payload: 'plaintext' });
// @ts-expect-error mode is X or S
sdk.add('stream', { count: 0 }, 'Y');
// @ts-expect-error not JSON
dynamic.add('invalid', new Date());
// @ts-expect-error SDK errors have fixed metadata, not a payload field
sdk.on('error', error => error.payload);
