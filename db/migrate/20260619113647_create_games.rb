class CreateGames < ActiveRecord::Migration[8.1]
  def change
    create_table :games do |t|
      t.references :user, null: false, foreign_key: true
      t.text :fen
      t.text :pgn
      t.string :status, null: false, default: "active"
      t.string :result

      t.timestamps
    end
  end
end
