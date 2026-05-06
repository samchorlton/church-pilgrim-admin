-- Create table for daily church history facts
CREATE TABLE church_history_facts (
  id SERIAL PRIMARY KEY,
  month INTEGER NOT NULL CHECK (month >= 1 AND month <= 12),
  day INTEGER NOT NULL CHECK (day >= 1 AND day <= 31),
  year INTEGER,
  short_description TEXT NOT NULL,
  long_description TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for efficient date lookups
CREATE INDEX idx_church_history_facts_month_day ON church_history_facts(month, day);

-- Allow anonymous read access
GRANT SELECT ON church_history_facts TO anon;

-- Insert some sample data
INSERT INTO church_history_facts (month, day, year, short_description, long_description) VALUES
(4, 27, 1662, 'The Act of Uniformity is passed, reshaping worship across England.', 'The Act of Uniformity 1662 was a pivotal piece of legislation that required all clergy to use the Book of Common Prayer and be ordained by bishops. This act led to the Great Ejection, where nearly 2,000 Puritan ministers were forced to leave their parishes, fundamentally reshaping the religious landscape of England and strengthening the Anglican Church''s position.'),
(12, 25, NULL, 'Christmas Day - The celebration of Christ''s birth.', 'Christmas Day marks the traditional celebration of the birth of Jesus Christ. While the exact date of Christ''s birth is unknown, December 25th was chosen by the Roman Church in the 4th century, possibly to coincide with existing pagan winter solstice festivals. The celebration has evolved over centuries, incorporating various traditions from different cultures while maintaining its central focus on the Incarnation.'),
(10, 31, 1517, 'Martin Luther posts his 95 Theses, sparking the Reformation.', 'On this day, Martin Luther nailed his 95 Theses to the door of the Castle Church in Wittenberg, challenging the Catholic Church''s practice of selling indulgences. This act is traditionally considered the beginning of the Protestant Reformation, which would fundamentally transform Christianity in Europe and beyond, leading to the formation of numerous Protestant denominations and reshaping the religious, political, and social landscape of the Western world.'),
-- Facts for today (April 20th)
(4, 20, 1534, 'The Act of Supremacy is passed, making Henry VIII head of the Church of England.', 'The Act of Supremacy declared King Henry VIII as the Supreme Head of the Church of England, formally breaking with papal authority and establishing the English Reformation. This momentous legislation arose from Henry''s desire to annul his marriage to Catherine of Aragon, but its consequences extended far beyond royal matrimony. It fundamentally altered the religious landscape of England, leading to the dissolution of monasteries, the redistribution of church lands, and the establishment of a national church that would influence English Christianity for centuries to come.'),
(4, 20, 1653, 'Oliver Cromwell dissolves the Rump Parliament, strengthening Puritan influence.', 'On this day, Oliver Cromwell forcibly dissolved the Rump Parliament, declaring "You have sat too long for any good you have been doing lately." This action consolidated power under the Commonwealth and strengthened Puritan religious policies across England. Under Cromwell''s rule, many Anglican practices were suppressed, church decorations were removed, and a more austere form of Protestant worship was enforced. This period saw the temporary triumph of Puritan ideals over traditional Anglican practices.'),
(4, 20, 1792, 'France declares war on Austria, beginning the French Revolutionary Wars that would impact European Christianity.', 'The declaration of war by revolutionary France against Austria marked the beginning of conflicts that would profoundly affect Christianity across Europe. The French Revolution had already begun dismantling the Catholic Church''s power in France, seizing church lands and requiring clergy to swear loyalty to the state. These wars would spread revolutionary ideals across Europe, challenging traditional relationships between church and state, and leading to significant changes in how Christianity was practiced and organized throughout the continent.');

