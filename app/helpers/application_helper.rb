module ApplicationHelper
  # The Agentforce deployment the embedded chat widget should use. Single-deployment today
  # (the registry default); when SOMA/MOMA adds entries, swap this for a per-page/per-user
  # selection without touching the layout.
  def current_agent_deployment
    AgentDeployment.default
  end
end
