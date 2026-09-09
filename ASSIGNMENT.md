# Developer Assignment: OBS Control App with SvelteKit & Node.js

## Objective

Develop a web application that integrates with OBS Studio to control key streaming/recording functions. The app should allow users to:

- Start a recording
- Stop a recording
- Switch scenes
- Display the current recording filename
- See "Bonus Features"

This assignment evaluates your ability to work with SvelteKit or SvelteKit (Single-page app) + Node.js.

## Requirements

### Frontend

- Create a minimal but intuitive UI using SvelteKit.
- Implement buttons to start/stop recordings and switch scenes.
- Display the current recording filename.
- Use Tailwind for this assignment.

### Backend

- In SvelteKit, with API routes for the OBS interactions
- Implement necessary logic to communicate with OBS.
- Handle recording and scene switching operations.
- Ensure proper error handling and logging.

### Bonus Features (Optional but encouraged)

- Provide a dropdown list of available scenes fetched from OBS.
- Use of Svelte Store or Runes to store, for example, the available OBS scenes
- Create a Dockerfile for easy deployment.
- Real-time Updates: Reflect OBS status dynamically, for example timecode and newly created scenes in OBS

### Technical Expectations

- Use TypeScript or JavaScript (developer's choice).
- Maintain clean, modular, and well-documented code.
- Implement basic error handling and UI feedback.

## Submission Guidelines

- Provide a GitHub repository with the full project, at least one day before the follow-up meeting
- Include a README with setup instructions.
- Ensure the project runs smoothly with clear instructions.

## Evaluation Criteria

- **Functionality:** Does the app work as expected?
- **Code Quality:** Is the code clean, structured, and maintainable? Does the implementation reflect Svelte knowledge
- **UI/UX:** Is the interface user-friendly and responsive?
- **Error Handling:** Are edge cases handled gracefully?
