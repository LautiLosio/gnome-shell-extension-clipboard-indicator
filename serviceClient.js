import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// The helper is a child process, reachable only through these private pipes.
export class ServiceClient {
    constructor(path, uuid) {
        this.pending = new Map();
        this.serial = 0;
        this.closed = false;
        this.queue = Promise.resolve();
        const root = GLib.build_filenamev([GLib.get_user_data_dir(), uuid]);
        const runtime = GLib.build_filenamev([root, 'runtime', 'bin', 'python']);
        const python = GLib.file_test(runtime, GLib.FileTest.EXISTS) ? runtime : 'python3';
        const launcher = new Gio.SubprocessLauncher({flags:
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE});
        launcher.setenv('OPENBLAS_NUM_THREADS','1',true);
        launcher.setenv('OMP_NUM_THREADS','2',true);
        launcher.setenv('TOKENIZERS_PARALLELISM','false',true);
        this.process = launcher.spawnv(['nice','-n','10',python, `${path}/history_service.py`, root,
            `${GLib.get_user_cache_dir()}/${uuid}/registry.txt`]);
        this.input = this.process.get_stdin_pipe();
        this.output = new Gio.DataInputStream({base_stream: this.process.get_stdout_pipe()});
        this.cancel = new Gio.Cancellable();
        this.read();
    }

    read() {
        this.output.read_line_async(GLib.PRIORITY_DEFAULT, this.cancel, (stream, result) => {
            if (this.closed) return;
            try {
                const [line] = stream.read_line_finish_utf8(result);
                if (line === null) throw new Error('History helper stopped. Toggle the extension to restart it.');
                const reply = JSON.parse(line);
                const pending = this.pending.get(reply.id);
                this.pending.delete(reply.id);
                if (pending) reply.error ? pending.reject(new Error(reply.error)) : pending.resolve(reply.result);
                this.read();
            } catch (error) { this.fail(error); }
        });
    }

    request(op, fields = {}) {
        if (this.closed) return Promise.reject(new Error('History helper is unavailable'));
        const id = ++this.serial;
        const answer = new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
        const bytes = new TextEncoder().encode(JSON.stringify({id, op, ...fields}) + '\n');
        this.queue = this.queue.then(() => new Promise((resolve, reject) => {
            this.input.write_all_async(bytes, GLib.PRIORITY_DEFAULT, this.cancel, (stream, result) => {
                try { stream.write_all_finish(result); resolve(); } catch (error) { reject(error); }
            });
        })).catch(error => this.fail(error));
        return answer;
    }

    fail(error) {
        this.closed = true;
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }

    destroy() {
        this.fail(new Error('Extension disabled'));
        this.cancel.cancel();
        // Closing stdin lets SQLite finish any in-flight transaction before exit.
        this.queue.finally(() => {
            try { this.input.close(null); } catch (_) { /* already closed */ }
        });
    }
}
