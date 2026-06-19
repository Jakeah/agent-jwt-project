Rails.application.routes.draw do
  devise_for :users

  # Mints the RS256 User Verification JWT for the logged-in user. The Agentforce Stimulus
  # controller fetches this on `onEmbeddedMessagingReady` and on token expiry.
  get "identity_token", to: "identity_tokens#show"

  resources :games, only: %i[index show create] do
    member do
      patch :move      # persist a played move (FEN/PGN update)
      patch :finish    # mark game over (result/status)
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
