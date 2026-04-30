# browser skill task

objective:
- browse a local html file and extract visible text

expected orchestration:
- planner creates browser.navigate then browser.extract
- router resolves both steps to the browser skill
- jury accepts the extracted text when it is non-empty and structurally valid
- task state advances from routing to verifying to completed

notes:
- this example uses file:// to keep the smoke test self-contained
- the same shape can be used for http(s) page capture once browser automation expands
