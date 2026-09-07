# Local-first recovery boundary and precedence

Ongoing drawing recovery is owned by a Recovery copy in the player's browser, preserving the unfinished draft and undo/redo history without periodic full-quality uploads to the GM. On resume, local work wins over older GM-held data; an eligible GM Full submission is a fallback only when the local Recovery copy is missing, and quick GM previews are never recovery sources. This boundary avoids continuous transfer and retention of full-quality work while preserving editable same-browser recovery, accepting that clearing browser storage or changing devices can lose work that was never fully submitted or captured when the Prompt closed.

Alternative rejected: periodic full-quality GM checkpoints. They would improve cross-device and unavailable-player recovery, but add continual bandwidth, retention, acknowledgement, and revision-reconciliation costs; they also create competing authoritative copies.

Alternative rejected: recover from quick GM previews. They are reduced, possibly incomplete review artifacts and cannot preserve editable history, so treating them as recovery would silently degrade or misrepresent player work.
