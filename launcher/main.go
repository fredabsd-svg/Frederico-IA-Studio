// Frederico AI Studio — Launcher (.exe)
//
// Um atalho amigável para ligar o app sem digitar comandos. Ele:
//   1) confere se o Docker Desktop está rodando (e tenta abri-lo se não estiver);
//   2) garante a imagem do sandbox;
//   3) sobe tudo com `docker compose up -d --build` (incluindo o docling-service
//      quando DOCLING_ENABLED=true no .env);
//   4) espera o app responder e abre o navegador em http://localhost:5173;
//   5) deixa a janela aberta para você DESLIGAR quando quiser (tecla S).
//
// Compile para Windows a partir do Linux/macOS:
//   GOOS=windows GOARCH=amd64 go build -o "Frederico AI Studio.exe" ./launcher
//
// Coloque o .exe na RAIZ do projeto (mesma pasta do docker-compose.yml).
package main

import (
	"bufio"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const frontendURL = "http://localhost:5173"

func main() {
	title("FREDERICO AI STUDIO")

	// Trabalha na pasta ONDE o .exe está (a raiz do projeto).
	dir := exeDir()
	if err := os.Chdir(dir); err != nil {
		fatal("Não consegui entrar na pasta do programa: " + err.Error())
	}
	if !exists("docker-compose.yml") {
		fatal("Não achei o docker-compose.yml aqui.\n" +
			"Coloque este programa DENTRO da pasta do projeto (onde está o docker-compose.yml)\n" +
			"pasta atual: " + dir)
	}
	if !exists(".env") {
		fatal("Falta o arquivo .env nesta pasta.\n" +
			"Sem ele o app não sobe. Coloque o seu .env e rode de novo.")
	}

	// 1) Docker precisa estar rodando.
	fmt.Println("[1/4] Verificando o Docker...")
	if !dockerReady() {
		fmt.Println("      Docker não está pronto. Tentando abrir o Docker Desktop...")
		startDockerDesktop()
		if !waitFor("o Docker ficar pronto", 120*time.Second, dockerReady) {
			fatal("O Docker Desktop não ficou pronto.\n" +
				"Abra o \"Docker Desktop\" manualmente, espere o ícone ficar VERDE e rode de novo.")
		}
	}
	fmt.Println("      Docker OK.")

	// 2) Docling ligado? Decide o profile do compose lendo o .env.
	profile := doclingEnabled()
	if profile {
		fmt.Println("[2/4] Docling ATIVADO no .env — subindo também o docling-service.")
	} else {
		fmt.Println("[2/4] Docling desligado (padrão). Para ligar: DOCLING_ENABLED=true no .env.")
	}

	// 3) Sobe o app (build + up em segundo plano).
	fmt.Println("[3/4] Construindo e ligando o app (a 1ª vez pode demorar bastante)...")
	args := []string{"compose"}
	if profile {
		args = append(args, "--profile", "docling")
	}
	args = append(args, "up", "-d", "--build")
	if err := runStreaming("docker", args...); err != nil {
		fatal("Falha ao subir o app:\n" + err.Error() +
			"\n\nDica: veja os logs com  docker compose logs -f")
	}

	// 4) Espera o frontend responder e abre o navegador.
	fmt.Println("[4/4] Aguardando o app responder em " + frontendURL + " ...")
	if waitFor("o app abrir", 90*time.Second, frontendUp) {
		openBrowser(frontendURL)
		fmt.Println("      Pronto! O app abriu no navegador.")
	} else {
		fmt.Println("      O app ainda está subindo. Abra manualmente: " + frontendURL)
	}

	// Menu final: manter rodando ou desligar.
	fmt.Println()
	fmt.Println("============================================================")
	fmt.Println("  O app está RODANDO em segundo plano.")
	fmt.Println("  - Deixe como está para continuar usando.")
	fmt.Println("  - Digite  S  e Enter para DESLIGAR o app.")
	fmt.Println("  - Ou apenas feche esta janela (o app continua ligado).")
	fmt.Println("============================================================")
	reader := bufio.NewReader(os.Stdin)
	for {
		fmt.Print("> ")
		line, _ := reader.ReadString('\n')
		if strings.EqualFold(strings.TrimSpace(line), "S") {
			fmt.Println("Desligando o app...")
			_ = runStreaming("docker", "compose", "down", "--remove-orphans")
			fmt.Println("App desligado. Pode fechar a janela.")
			pause()
			return
		}
	}
}

// ---- helpers ---------------------------------------------------------------

func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		wd, _ := os.Getwd()
		return wd
	}
	return filepath.Dir(exe)
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func dockerReady() bool {
	return exec.Command("docker", "info").Run() == nil
}

func frontendUp() bool {
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(frontendURL)
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode < 500
}

func waitFor(what string, max time.Duration, ok func() bool) bool {
	deadline := time.Now().Add(max)
	for time.Now().Before(deadline) {
		if ok() {
			return true
		}
		fmt.Print(".")
		time.Sleep(3 * time.Second)
	}
	fmt.Println()
	_ = what
	return false
}

// Lê o .env e retorna true se DOCLING_ENABLED=true.
func doclingEnabled() bool {
	data, err := os.ReadFile(".env")
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(strings.ToUpper(line), "DOCLING_ENABLED") {
			parts := strings.SplitN(line, "=", 2)
			if len(parts) == 2 && strings.EqualFold(strings.TrimSpace(parts[1]), "true") {
				return true
			}
		}
	}
	return false
}

func startDockerDesktop() {
	candidates := []string{
		`C:\Program Files\Docker\Docker\Docker Desktop.exe`,
		os.Getenv("ProgramFiles") + `\Docker\Docker\Docker Desktop.exe`,
	}
	for _, p := range candidates {
		if exists(p) {
			_ = exec.Command(p).Start()
			return
		}
	}
}

func openBrowser(url string) {
	// Windows: cmd /c start "" <url>
	_ = exec.Command("cmd", "/c", "start", "", url).Start()
}

func runStreaming(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func title(s string) {
	fmt.Println("============================================================")
	fmt.Println("  " + s)
	fmt.Println("============================================================")
	fmt.Println()
}

func fatal(msg string) {
	fmt.Println()
	fmt.Println("  [X] " + msg)
	fmt.Println()
	pause()
	os.Exit(1)
}

func pause() {
	fmt.Println("Pressione Enter para fechar...")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
}
