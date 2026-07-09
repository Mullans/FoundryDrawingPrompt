# Future Items

These are features or ideas for future updates. These should be considered "brainstorm" items and should be thought out in more detail before actual implementation.

1. Change "Save only" to "Save" and then put a right-facing arrow between "Save" and "Place". It should be clear that the right buttons require the DM to save the submission before it can be placed.
2. Ability to create a new token either 1. with a default actor or 2. for an existing actor with the new art
3. Ability to transform an existing token (ie. same as other "transform" effects - just a temporary art change on a token, but no stat changes) - "Transform Token" option near "Place" options.
4. Add a maximum width to the setup view
5. The canvas for the player should **NEVER** change aspect ratio. It should always resize to fully fit the drawing area inside the window, and the drawing area and image should always preserve aspect ratio as it resizes.
6. The "Save drawing" dialog is forced to the top rather than just opened on top. This means that the Folder Browser is stuck under the "Save drawing" window even when using the Folder Browser to pick a folder for the "Save drawing". The Folder Browser is also not able to be interacted with while the save drawing window is open.
7. The images are being saved at "worlds/drawing/drawing-prompts" relative to the root on Forge. It should instead be "drawing-prompts" in the Forge assets root (as appears to be the custom for Forge-compatible foundry modules)
8. Images still have non-useful folder and file names.
9. The preview in the prompt manager should preserve its apsect ratio. It it representing the image with the described dimensions, so the preview should look exactly what the background image will look like given the image size and fit mode.