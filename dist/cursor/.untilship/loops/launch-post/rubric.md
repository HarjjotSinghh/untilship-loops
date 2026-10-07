# Launch post rubric

Each judge scores every criterion from 0 to 10. `score.mjs` computes the weighted total
out of 100 (weight × score / 10, summed) and averages it across judges.
Weights must add up to 100. Edit criteria to fit your channel, but do it before `start`:
this file is protected during a run.

## Criteria

- hook (20): The title and first two lines make the intended reader stop and keep reading. Specific beats clever. 0 = generic ("Introducing X"), 10 = a reader in the target audience cannot skip it.
- clarity (20): A reader who has never heard of the product can say what it is, who it is for and what it does after one read. 0 = jargon or vague, 10 = obvious in one sentence.
- proof (20): At least one concrete, verifiable proof point from the brief (number, demo, quote, benchmark). Claims not in the brief count against this. 0 = only adjectives, 10 = proof a skeptic would accept.
- reader_value (15): The post is about the reader's problem and outcome, not the team's feelings. 0 = "we're thrilled", 10 = every paragraph earns its place for the reader.
- voice (10): Sounds like a person, plain words, no hype, fits the channel in the brief. 0 = marketing boilerplate, 10 = reads like a sharp founder wrote it.
- call_to_action (15): Ends with one clear, low-friction next step and the link from the brief. 0 = no ask or several competing asks, 10 = one obvious action.
