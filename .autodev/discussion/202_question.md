Update for you: regarding the bug investigation that is ongoing. It turns out that in these tests you are running, the edit is past \end{document}. There was a bug in supertex whereby this wasn't handled properly, it should obviously just issue a [round-done] in this case. This has now been fixed upstream and the vendor's patch has been manually git-pulled in by me. So I think everything shyould just work.

However for the gold tests where you're checking for edit-then-pdf-update it would probably make sense to choose an edit where you're inserting the edit just *before* \end{document}.

Think about this, smoke test as necessary, and update PLAN.md accordingly.