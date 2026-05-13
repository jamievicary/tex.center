How much clearer should I need to make this. You should NOT create a test to pin this failure, until you have already smoke-tested that the test you are about to create does pin the failure!!

You have done a smoke test that catches the error in 220_answer.md. Read it. So find a way to reproduce it, you might have to go through the real production side car (make a new project, paste in the lines, etc).

Only then when you have reproduced the error, add the failing gold test to pin the issue. Otherwise we're in this ridiculous loop where you keep adding pinning tests that already pass!!
