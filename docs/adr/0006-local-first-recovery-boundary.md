# Local-first recovery boundary and precedence

Ongoing drawing recovery is owned by a Recovery copy in the player's browser, preserving the unfinished draft and undo/redo history without periodic full-quality uploads to the GM. On resume, local work wins over every GM-held capture. Only when the local Recovery copy is missing may recovery use the newest available GM-held capture that belongs to the same Assignment and contains usable full-quality Submission image data; quick GM previews and Saved previews are never eligible. This boundary avoids continuous transfer and retention of full-quality work while preserving editable same-browser recovery, accepting that clearing browser storage or changing devices can lose work that was never fully submitted or captured before the Prompt became Closed.

Alternative rejected: periodic full-quality GM checkpoints. They would improve cross-device and unavailable-player recovery, but add continual bandwidth, retention, acknowledgement, and revision-reconciliation costs; they also create competing authoritative copies.

Alternative rejected: recover from quick GM previews or Saved previews. They are reduced or artwork-only review artifacts and cannot preserve editable history, so treating them as recovery would silently degrade or misrepresent player work.
