-- schema.sql
-- Run this against your Azure SQL Database (e.g. via SSMS, Azure Data Studio, or Query Editor in Portal)

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Items')
BEGIN
    CREATE TABLE Items (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Name NVARCHAR(200) NOT NULL,
        Description NVARCHAR(1000) NULL,
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

-- Sample seed data (optional)
INSERT INTO Items (Name, Description) VALUES
('Sample Item 1', 'First test row'),
('Sample Item 2', 'Second test row');
GO
