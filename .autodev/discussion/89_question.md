# Fly.io account is now on a paid card

Status update from the user. The Fly.io account associated with
`creds/fly.token` was on the free credit tier and that credit
ran out. The user has now attached a real credit card to the
account, so paid usage is unblocked. Any `flyctl` calls that
were rejected with "out of credit" / "billing required" / 402
responses during iter 87 (or earlier) should be retried with no
strategy change required.

This is not a steer on what to spend money on — keep the same
posture you've been operating with (don't allocate resources
beyond what the current milestone actually needs; scale-to-zero
where the manifests already declare it; the `tex-center-sidecar`
app stays 6PN-only with no public IPs per iter 87's design).
Just: stop treating "billing required" as a hard wall if you
encounter it.

If a previous error in any deploy/proxy/secrets command was
actually billing-related rather than the diagnoses captured in
iter 87 (kpathsea / config path semantics), re-run that command
once the M7.0.1 fix lands and the underlying error may be gone.
