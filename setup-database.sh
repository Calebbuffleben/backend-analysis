#!/bin/bash

# Script para criar o banco de dados PostgreSQL localmente
# Uso: ./setup-database.sh

set -e

DB_NAME="live_meeting"
DB_USER="user"
DB_PASSWORD="password"

echo "🗄️  Configurando banco de dados PostgreSQL..."

# Verifica se o PostgreSQL está rodando
if ! pg_isready -q; then
    echo "❌ PostgreSQL não está rodando. Por favor, inicie o serviço:"
    echo "   brew services start postgresql@16"
    echo "   ou"
    echo "   brew services start postgresql"
    exit 1
fi

echo "✅ PostgreSQL está rodando"

# Cria o usuário (se não existir)
echo "📝 Criando usuário '$DB_USER'..."
psql -d postgres -tc "SELECT 1 FROM pg_user WHERE usename = '$DB_USER'" | grep -q 1 || \
    psql -d postgres -c "CREATE USER \"$DB_USER\" WITH PASSWORD '$DB_PASSWORD';" || \
    echo "⚠️  Usuário já existe ou erro ao criar"

# Define permissões
echo "🔐 Configurando permissões..."
psql -d postgres -c "ALTER USER \"$DB_USER\" CREATEDB;" || true

# Cria o banco de dados (se não existir)
echo "📦 Criando banco de dados '$DB_NAME'..."
psql -d postgres -tc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1 || \
    psql -d postgres -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\";" || \
    echo "⚠️  Banco de dados já existe ou erro ao criar"

# Concede permissões
psql -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE \"$DB_NAME\" TO \"$DB_USER\";" || true

echo ""
echo "✅ Banco de dados '$DB_NAME' configurado com sucesso!"
echo ""
echo "📋 Detalhes da conexão:"
echo "   Database: $DB_NAME"
echo "   User: $DB_USER"
echo "   Password: $DB_PASSWORD"
echo "   Connection String: postgresql://$DB_USER:$DB_PASSWORD@localhost:5432/$DB_NAME?schema=public"
echo ""
echo "🚀 Próximos passos:"
echo "   1. Certifique-se de que o arquivo .env está configurado"
echo "   2. Execute: pnpm prisma:generate"
echo "   3. Execute: pnpm prisma:migrate"

