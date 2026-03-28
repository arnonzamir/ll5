import readline from 'node:readline';

/**
 * Prompt the user for input. If `hidden` is true, input is not echoed (for PINs).
 */
export function prompt(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    if (hidden) {
      // Mute output for hidden input by replacing stdout.write temporarily
      const stdout = process.stdout;
      const origWrite = stdout.write.bind(stdout) as typeof stdout.write;
      let questionPrinted = false;

      stdout.write = ((
        chunk: string | Uint8Array,
        ...args: unknown[]
      ): boolean => {
        if (!questionPrinted) {
          questionPrinted = true;
          return (origWrite as Function).call(stdout, chunk, ...args);
        }
        // Suppress echoed characters but allow newline at the end
        if (chunk === '\n' || chunk === '\r\n') {
          return (origWrite as Function).call(stdout, chunk, ...args);
        }
        return true;
      }) as typeof stdout.write;

      rl.question(question, (answer) => {
        stdout.write = origWrite;
        stdout.write('\n');
        rl.close();
        resolve(answer);
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}
