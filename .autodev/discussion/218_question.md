Regarding this comment in log 217:

"**Unexpected observation:** the daemon's stderr includes
  lines like `supertex: edit detected at .../main.tex:49`,
  i.e. it watches the source file in addition to processing
  stdin commands. The iter-215 claim ("stdin-driven only, does
  not auto-reload on disk edits", `214_answer.md`) is
  therefore wrong."

No you haven't interpreted this correctly. In daemon mode, supertex is STDIN-DRIVEN ONLY. When it receives the "recompile,T" command through stdin, of course then it does check the input files to determine what checkpoint to resume from, and it's at that point that it emits lines like "supertex: edit detected".

To confirm, *supertex in --daemon mode is stdin-driven only*.
