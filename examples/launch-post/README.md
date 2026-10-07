# Fixture: launch-post

`launch/brief.md` is the approved brief; `launch/post.md` is a first draft that fails the
gates (hype words, placeholder, no link, too short). `solution/launch/post.md` passes.
`fake-judge.mjs` is a deterministic **test double** for an external judge such as
`claude -p`; it is not a real panel.

```bash
UNTILSHIP_JUDGE="node fake-judge.mjs" untilship-check peek
```
