#!/usr/bin/env python3
"""Extrai a API PÚBLICA dos kits de documento e a imprime como JSON.

Serve ao `promptKits.test.js`, que trava o prompt do assistente "Documentos
profissionais" contra a API real: todo `objeto.metodo(` citado no prompt tem de
existir de fato em `sandbox/*.py`.

A leitura é por `ast`, não por `import`: assim o teste roda no job de backend do
CI, que é Node puro e não tem python-docx, openpyxl nem reportlab instalados.
Importar exigiria essas dependências e o teste acabaria se auto-pulando — que é
o mesmo que não existir.
"""
import ast
import json
import os
import sys

RAIZ = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "sandbox")
MODULOS = ("kits", "docpro", "xlspro", "pdfpro")


def _publicos(corpo):
    return sorted({no.name for no in corpo
                   if isinstance(no, (ast.FunctionDef, ast.AsyncFunctionDef))
                   and not no.name.startswith("_")})


def _argumentos(no):
    args = no.args
    nomes = [a.arg for a in args.posonlyargs + args.args + args.kwonlyargs]
    return [n for n in nomes if n != "self"]


def api():
    saida = {"classes": {}, "funcoes": {}, "assinaturas": {}}
    for modulo in MODULOS:
        caminho = os.path.join(RAIZ, modulo + ".py")
        arvore = ast.parse(open(caminho, encoding="utf-8").read(), caminho)
        saida["funcoes"][modulo] = _publicos(arvore.body)
        for no in arvore.body:
            if not isinstance(no, ast.ClassDef):
                continue
            saida["classes"][no.name] = _publicos(no.body)
            for metodo in no.body:
                if isinstance(metodo, ast.FunctionDef):
                    saida["assinaturas"]["%s.%s" % (no.name, metodo.name)] = \
                        _argumentos(metodo)
        for no in arvore.body:
            if isinstance(no, ast.FunctionDef) and not no.name.startswith("_"):
                saida["assinaturas"]["%s.%s" % (modulo, no.name)] = _argumentos(no)
    return saida


if __name__ == "__main__":
    json.dump(api(), sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
