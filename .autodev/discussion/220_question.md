Here is my repro for this compile crash:

1. Create a new project which will initialise with the "Hello, world!" text.
2. Add the new line

      \newpage XX

just before "\end{document}"
3. Repeat step 2 every ~500ms. After about 15 instances I get the red error toast.

You really should be able to repro this. If not, can you look at the logs from the real runs somehow? Come on, be creative and imaginative and find a way to diagnose this please.
