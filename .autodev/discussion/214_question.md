In 213_answer you wrote:

"the upstream supertex daemon's
auto-reload-on-edit fires when the source file mutates on disk,
independent of our compile gate"

That is NOT correct when supertex is being run in --daemon mode. The whole point of that mode is, it does nothing until it receives input from stdin of the form "recompile,T" where T is the target page for the compile. For the tex.center project we ALWAYS run supertex in --daemon mode.

However we DO need to avoid tex files changing while the daemon is compiling (i.e. during the brief period of time after receiving an "recompile,T" input when output blobs are being shipped out.) For this reason the tex.center backend should have some sort of caching system, so that the state is extracted from the Yjs blob only when necessary for the recompile? I'm unsure what the method is, but make sure there is a simple and logical approach being taken.
