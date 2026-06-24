.PHONY: agents audit fix evolve report install-hook

agents:
	python3 agents/run_agents.py

audit:
	python3 agents/run_agents.py --mode audit

fix:
	python3 agents/run_agents.py --mode fix

evolve:
	python3 agents/run_agents.py --mode evolve

report:
	cat agents/AGENT_REPORT.md

install-hook:
	cp agents/hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
	@echo "pre-commit hook installed"
