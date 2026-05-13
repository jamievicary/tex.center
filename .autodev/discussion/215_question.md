Regarding the tests you have added to isolate the issue raised in question 214. They are passing!! You should have smoke-tested the new tests first to ensure they are failing. Otherwise it's a waste of an itearation. Think more carefully about what you are doing.

Also, 0ms between character typing is not realistic at all. It doesn't give time for comms to happen between the front and backend which could be where the issue is.

Also also, when I get this crash, I'm usually pasting lines like

\newpage X

into the latex document, to swell the page count. That's a clue.

SMOKE TEST YOURSELF TO REPLICATE THE ERROR BEFORE CREATING THE PINNING GOLD TESTS.
