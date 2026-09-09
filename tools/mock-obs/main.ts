/**
 * CLI entry point for the mock OBS server: `npm run mock`.
 *
 * Reads the same environment variables as the application, so pointing the app at the
 * mock is a matter of matching ports. Typing commands on stdin drives OBS-side changes
 * — creating a scene, splitting the recording file, dropping the connection — which is
 * how the real-time behaviour is demonstrated without touching OBS.
 */
import { createInterface } from 'node:readline';
import { MockObsServer } from './server.js';

const HELP = `
Commands
  record start|stop|pause|resume|split   drive the record output
  scene <name>                           switch program scene
  scene add|rm <name>                    create or remove a scene
  scene rename <from> <to>               rename a scene
  preview <name>                         set the preview scene (studio mode only)
  transition                             preview -> program (studio mode only)
  studio on|off                          toggle studio mode
  drop <ms>                              lose media time, as an overloaded encoder would
  kill                                   disconnect every client
  status                                 print current state
  help | quit
`.trim();

const port = Number(process.env.MOCK_OBS_PORT ?? 4455);
const host = process.env.MOCK_OBS_HOST ?? '127.0.0.1';
const password = process.env.OBS_PASSWORD?.trim() || undefined;

const server = new MockObsServer({
	host,
	port,
	password,
	omitOutputPathOnStart: process.env.MOCK_OMIT_OUTPUT_PATH === '1',
	recordDirectory: process.env.MOCK_RECORD_DIR ?? '/home/user/Videos'
});

const bound = await server.start();
console.log(`mock-obs listening on ws://${host}:${bound}`);
console.log(password ? 'authentication: enabled' : 'authentication: disabled');
if (process.env.MOCK_OMIT_OUTPUT_PATH === '1') {
	console.log('emulating an OBS build that omits outputPath on record start');
}
console.log(`\n${HELP}\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'mock> ' });
rl.prompt();

rl.on('line', (line) => {
	const [command, ...args] = line.trim().split(/\s+/);
	try {
		run(command ?? '', args);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
	}
	rl.prompt();
});

rl.on('close', () => {
	void server.stop().then(() => process.exit(0));
});

function run(command: string, args: string[]): void {
	const state = server.state;

	switch (command) {
		case '':
			return;

		case 'record':
			switch (args[0]) {
				case 'start':
					return server.apply(() => state.startRecording());
				case 'stop': {
					const { events, outputPath } = state.stopRecording();
					server.broadcast(events);
					console.log(`saved ${outputPath}`);
					return;
				}
				case 'pause':
					return server.apply(() => state.pauseRecording());
				case 'resume':
					return server.apply(() => state.resumeRecording());
				case 'split':
					return server.apply(() => state.splitRecordFile());
				default:
					console.log('record start|stop|pause|resume|split');
					return;
			}

		case 'scene': {
			const [sub, ...rest] = args;
			if (sub === 'add') return server.apply(() => state.createScene(rest.join(' ')));
			if (sub === 'rm') return server.apply(() => state.removeScene(rest.join(' ')));
			if (sub === 'rename') {
				const [from, to] = [rest[0], rest.slice(1).join(' ')];
				return server.apply(() => state.renameScene(from ?? '', to));
			}
			return server.apply(() => state.setProgramScene(args.join(' ')));
		}

		case 'preview':
			return server.apply(() => state.setPreviewScene(args.join(' ')));

		case 'transition':
			return server.apply(() => state.triggerTransition());

		case 'studio':
			return server.apply(() => state.setStudioMode(args[0] !== 'off'));

		case 'drop':
			state.dropFrames(Number(args[0] ?? 1000));
			console.log(`dropped ${args[0] ?? 1000}ms of media time`);
			return;

		case 'kill':
			server.dropClients();
			console.log('clients disconnected');
			return;

		case 'status':
			console.log({
				clients: server.clientCount,
				program: state.program,
				preview: state.preview,
				studioMode: state.studioMode,
				scenes: state.scenes.map((scene) => scene.name),
				recording: state.recordStatus()
			});
			return;

		case 'help':
			console.log(HELP);
			return;

		case 'quit':
		case 'exit':
			rl.close();
			return;

		default:
			console.log(`unknown command '${command}' — type help`);
	}
}
