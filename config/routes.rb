Rails.application.routes.draw do
  devise_for :users

  # Mints the RS256 User Verification JWT for the logged-in user. The Agentforce Stimulus
  # controller fetches this on `onEmbeddedMessagingReady` and on token expiry.
  get "identity_token", to: "identity_tokens#show"

  # Server-to-server pull of the player's LIVE game state for the verified MIAW coach. Called by an
  # Agentforce Apex action (ChessCoachGetLiveGame) each turn, keyed by the verified Contact's email,
  # because hidden prechat goes stale on a verified user's persistent conversation (the continuity
  # trap — see docs/miaw-prechat-to-agent-guide.md). Bearer-token auth, NOT a Devise session.
  get "coach/game_state", to: "coach_game_states#show"

  resources :games, only: %i[index show create] do
    member do
      patch :move      # persist a played move (FEN/PGN update)
      patch :finish    # mark game over (result/status)
    end

    # Headless Agentforce Agent API chat for the MCP coach (the auto-comment path). A chat session
    # is scoped to one (user, game), so it nests under the game. The frontend posts each completed
    # turn to .../agent_chat/message and renders the reply; create/destroy bracket the SF session.
    resource :agent_chat, only: %i[create destroy], controller: "agent_chats" do
      post :message
    end
  end

  # Reveal health status on /up that returns 200 if the app boots with no exceptions, otherwise 500.
  # Can be used by load balancers and uptime monitors to verify that the app is live.
  get "up" => "rails/health#show", as: :rails_health_check

  # Render dynamic PWA files from app/views/pwa/* (remember to link manifest in application.html.erb)
  # get "manifest" => "rails/pwa#manifest", as: :pwa_manifest
  # get "service-worker" => "rails/pwa#service_worker", as: :pwa_service_worker

  # Authenticated users land on their games list; everyone else is bounced to login
  # by the before_action in GamesController.
  root "games#index"
end
