"""Local C2Rust compatibility patches; the game's source is not changed."""
from pathlib import Path
import shutil
root=Path(__file__).resolve().parent.parent
registry=next((root/'private/cargo-cache/registry/src').iterdir())
dest=root/'private/c2rust-source'
for name in ['c2rust','c2rust-ast-exporter','c2rust-transpile']:
    target=dest/name
    if not target.exists(): shutil.copytree(registry/(name+'-0.22.1'),target)
p=dest/'c2rust-ast-exporter/src/AstExporter.cpp'
s=p.read_text()
before='''        printDiag(Context, DiagnosticsEngine::Warning, "Encountered unsupported generic selection expression", E);
        return true;'''
after='''        // C11 _Generic is resolved by Clang at compile time. Preserve its
        // selected expression and discard only non-evaluated alternatives.
        if (E->isResultDependent()) return false;
        std::vector<void *> childIds{E->getResultExpr()};
        encode_entry(E, TagParenExpr, childIds);
        return true;'''
if after not in s:
    assert s.count(before)==1
    s=s.replace(before,after)
before='''            visitor.TraverseDecl(translation_unit);'''
after='''            // Clang injects an unused wasm externref typedef. C2Rust 0.22
            // cannot model it; omit this implicit root only. A real reference
            // still traverses the type and fails instead of changing its ABI.
            std::vector<Decl *> unusedWasmTypes;
            for (auto d : translation_unit->decls()) {
                auto t = dyn_cast<TypedefNameDecl>(d);
                if (t && t->isImplicit() && t->getName() == "__externref_t") unusedWasmTypes.push_back(d);
            }
            for (auto d : unusedWasmTypes) translation_unit->removeDecl(d);
            visitor.TraverseDecl(translation_unit);'''
if after not in s:
    assert s.count(before)==1
    s=s.replace(before,after)
p.write_text(s)
p=dest/'c2rust/Cargo.toml';s=p.read_text()
if '[patch.crates-io]' not in s: s+='\n[workspace]\n\n[patch.crates-io]\nc2rust-ast-exporter = { path = "../c2rust-ast-exporter" }\n'
p.write_text(s)
print('Prepared local translator fixes for resolved C11 generics and unused wasm typedefs.')

p=dest/'c2rust/Cargo.toml'
s=p.read_text()
if 'c2rust-transpile = { path =' not in s:
    s+='c2rust-transpile = { path = "../c2rust-transpile" }\n'
p.write_text(s)
p=dest/'c2rust-transpile/src/translator/builtins.rs'
s=p.read_text()
anchor='            "__builtin_isfinite" | "__builtin_isnan" => {'
addition='''            "__builtin_fminf" | "__builtin_fmin" | "__builtin_fmaxf" | "__builtin_fmax" => {
                let left = self.convert_expr(ctx.used(), args[0], None)?;
                let right = self.convert_expr(ctx.used(), args[1], None)?;
                let method = if builtin_name.contains("fmin") { "min" } else { "max" };
                left.and_then(|left| right.and_then(|right| {
                    self.convert_side_effects_expr(ctx,
                        WithStmts::new_val(mk().method_call_expr(left, method, vec![right])),
                        "Builtin is not supposed to be used")
                }))
            }
'''
if addition not in s:
    assert s.count(anchor)==1
    s=s.replace(anchor,addition+anchor)
p.write_text(s)
