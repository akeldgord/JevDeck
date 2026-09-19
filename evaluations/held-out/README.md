Held-out material lives here at measurement time and is not committed.

Standing rule 4 of `SPEC.md` §7 keeps documents out of Git, and the material the quality gates are
measured on is no exception: the gates are only meaningful over material the pipeline was not
tuned on, and most such material is not redistributable.

Supply it by pointing the harness at the database it was generated into:

    bun scripts/evaluate.ts --database <path> --job <id> --template <review-file>

The format of a review file is documented in `../README.md`.
